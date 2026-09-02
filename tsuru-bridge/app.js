"use strict";

const $ = id => document.getElementById(id);
const CHUNK = 16 * 1024;
const WINDOW = 64;
const SESSION_MS = 10 * 60 * 1000;
const STORE_EXT = /\.(?:jpe?g|png|gif|webp|heic|heif|avif|mp4|mov|m4v|mp3|aac|m4a|zip|7z|rar|gz|bz2|xz|pdf|docx|xlsx|pptx)$/i;

let activeTab = "send";
let sendEntries = [];
let packEntries = [];
let unpackFile = null;
let senderPeer = null;
let senderConn = null;
let senderPayloadPromise = null;
let senderPayload = null;
let senderTimer = null;
let senderExpiresAt = 0;
let senderTransferring = false;
let recvPeer = null;
let recvConn = null;
let recvDir = null;
let recvWriter = null;
let recvParts = [];
let recvObjectUrl = null;
let recvMeta = null;
let recvBytes = 0;
let recvChunks = 0;
let recvQueue = Promise.resolve();
let lastAck = -1;
let ackWaiters = [];

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}
function pad2(n) { return String(n).padStart(2, "0"); }
function dateStamp() { const d = new Date(); return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}`; }
function safeBase(s) {
  return (s || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 80) || "files";
}
function totalBytes(entries) { return entries.reduce((n, e) => n + (e.file?.size || 0), 0); }
function topFolder(entries) {
  if (!entries.length) return "";
  const roots = new Set(entries.map(e => (e.path || e.file.name).split("/")[0]).filter(Boolean));
  const hasNested = entries.some(e => (e.path || "").includes("/"));
  return hasNested && roots.size === 1 ? [...roots][0] : "";
}
function packageName(entries) {
  const root = topFolder(entries);
  return root ? `TSURU-${dateStamp()}-${safeBase(root)}.zip` : `TSURU-${dateStamp()}-${entries.length}件.zip`;
}
function bundleLabel(entries) {
  const root = topFolder(entries);
  return root || (entries.length === 1 ? entries[0].file.name : `${entries.length}件`);
}
function setStatus(id, text, cls="") { const el=$(id); el.textContent=text || ""; el.className="status"+(cls?" "+cls:""); }
function setProgress(prefix, p, show=true) { const wrap=$(prefix+"Progress"), bar=$(prefix+"Bar"); wrap.classList.toggle("show", show); bar.style.width=Math.max(0,Math.min(100,p||0))+"%"; }
function setNet(on) { $("net").classList.toggle("on", !!on); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function bindTabs(){
  document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{
    activeTab=b.dataset.tab;
    document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("on",x===b));
    document.querySelectorAll(".panel").forEach(x=>x.classList.toggle("on",x.id===activeTab));
  }));
}

function filesToEntries(files){
  return Array.from(files || []).filter(f=>f && f.size >= 0).map(f=>({ file:f, path:(f.webkitRelativePath || f.name).replace(/^\/+/,"") }));
}

async function entriesFromDataTransfer(dt){
  const items=Array.from(dt.items||[]).filter(i=>i.kind==="file");
  const out=[];
  if (items.some(i=>typeof i.getAsFileSystemHandle==="function")) {
    for (const item of items){
      let h=null; try{h=await item.getAsFileSystemHandle();}catch{}
      if(h) await walkHandle(h,"",out);
    }
    return out;
  }
  if (items.some(i=>typeof i.webkitGetAsEntry==="function")) {
    for(const item of items){ const e=item.webkitGetAsEntry(); if(e) await walkWebkitEntry(e,"",out); }
    return out;
  }
  return filesToEntries(dt.files);
}
async function walkHandle(h,parent,out){
  const path=parent?`${parent}/${h.name}`:h.name;
  if(h.kind==="file"){ try{out.push({file:await h.getFile(),path});}catch{} return; }
  for await (const child of h.values()) await walkHandle(child,path,out);
}
function readAllEntries(reader){
  return new Promise((resolve,reject)=>{ const all=[]; const step=()=>reader.readEntries(xs=>{ if(!xs.length)return resolve(all); all.push(...xs); step();},reject); step(); });
}
async function walkWebkitEntry(e,parent,out){
  const path=parent?`${parent}/${e.name}`:e.name;
  if(e.isFile){ const f=await new Promise((res,rej)=>e.file(res,rej)); out.push({file:f,path}); return; }
  if(e.isDirectory){ const kids=await readAllEntries(e.createReader()); for(const k of kids) await walkWebkitEntry(k,path,out); }
}

function bindDrop(el, onEntries, zipOnly=false){
  let depth=0;
  el.addEventListener("dragenter",e=>{e.preventDefault();depth++;el.classList.add("over")});
  el.addEventListener("dragover",e=>e.preventDefault());
  el.addEventListener("dragleave",e=>{e.preventDefault();if(--depth<=0){depth=0;el.classList.remove("over")}});
  el.addEventListener("drop",async e=>{e.preventDefault();depth=0;el.classList.remove("over");
    if(zipOnly){ const f=Array.from(e.dataTransfer.files||[]).find(x=>/\.zip$/i.test(x.name)); if(f)onEntries(f); return; }
    const entries=await entriesFromDataTransfer(e.dataTransfer); if(entries.length)onEntries(entries);
  });
}

function renderBundle(kind, entries){
  const wrap=$(kind+"Bundle");
  if(!entries?.length){wrap.classList.remove("show");return;}
  $(kind+"Name").textContent=bundleLabel(entries);
  $(kind+"Meta").textContent=`${entries.length}件  ·  ${fmtBytes(totalBytes(entries))}`;
  wrap.classList.add("show");
}

async function makeZip(entries, progressCb){
  if(!window.JSZip) throw new Error("ZIP機能を読み込めません");
  const zip=new JSZip();
  for(const e of entries){
    let path=(e.path||e.file.name).replace(/\\/g,"/").replace(/^\/+/,"");
    if(!path) path=e.file.name;
    const compression=STORE_EXT.test(e.file.name)?"STORE":"DEFLATE";
    zip.file(path,e.file,{date:new Date(e.file.lastModified||Date.now()),binary:true,compression,compressionOptions:compression==="DEFLATE"?{level:4}:undefined,createFolders:true});
  }
  return zip.generateAsync({type:"blob",mimeType:"application/zip",streamFiles:true,platform:"DOS"},m=>progressCb?.(m.percent||0));
}

function randomCode(){
  const a=new Uint32Array(1); crypto.getRandomValues(a); return String(100000+(a[0]%900000));
}
function cleanupSender(){
  clearInterval(senderTimer); senderTimer=null; senderExpiresAt=0; senderTransferring=false;
  try{senderConn?.close()}catch{}; try{senderPeer?.destroy()}catch{};
  senderConn=null;senderPeer=null;senderPayloadPromise=null;senderPayload=null;lastAck=-1;ackWaiters=[];
  $("sendCodeWrap").classList.remove("show"); $("sendCode").textContent="------"; $("sendTtl").textContent=""; setNet(false);
}
function clearSend(){ cleanupSender(); sendEntries=[]; renderBundle("send",[]); setProgress("send",0,false); setStatus("sendStatus",""); }

async function setSendEntries(entries){
  cleanupSender(); sendEntries=entries.filter(e=>e.file && !e.file.name.startsWith("."));
  renderBundle("send",sendEntries); if(!sendEntries.length)return;
  setProgress("send",0,true); setStatus("sendStatus","準備中");
  senderPayloadPromise=(async()=>{
    if(sendEntries.length===1 && /\.zip$/i.test(sendEntries[0].file.name) && !sendEntries[0].path.includes("/")){
      setProgress("send",100,true);
      return {blob:sendEntries[0].file,name:sendEntries[0].file.name,count:1};
    }
    const blob=await makeZip(sendEntries,p=>setProgress("send",p,true));
    return {blob,name:packageName(sendEntries),count:sendEntries.length};
  })().then(v=>{senderPayload=v; if(senderPeer?.open)setStatus("sendStatus","接続待ち"); return v;}).catch(e=>{setStatus("sendStatus",e.message||"準備失敗","err");throw e});
  startSenderPeer();
}

function startSenderPeer(){
  if(!window.Peer){ setStatus("sendStatus","接続機能を読み込めません","err"); return; }
  const tryOpen=()=>{
    const code=randomCode();
    const peer=new Peer(`tsuru-${code}`,{debug:1}); senderPeer=peer;
    peer.on("open",()=>{
      if(senderPeer!==peer)return;
      $("sendCode").textContent=code; $("sendCodeWrap").classList.add("show"); setNet(true);
      senderExpiresAt=Date.now()+SESSION_MS;
      clearInterval(senderTimer); senderTimer=setInterval(()=>{
        if(senderTransferring)return;
        const left=Math.max(0,senderExpiresAt-Date.now()); const sec=Math.ceil(left/1000);
        $("sendTtl").textContent=`${Math.floor(sec/60)}:${pad2(sec%60)}`;
        if(left<=0){ clearInterval(senderTimer); setStatus("sendStatus","期限切れ","err"); try{peer.destroy()}catch{}; setNet(false); }
      },250);
      setStatus("sendStatus",senderPayload?"接続待ち":"準備中");
    });
    peer.on("connection",conn=>{
      if(senderConn && senderConn.open){try{conn.close()}catch{};return;}
      senderConn=conn; wireSenderConn(conn);
    });
    peer.on("error",err=>{
      if(senderPeer!==peer)return;
      if(err?.type==="unavailable-id"){ try{peer.destroy()}catch{}; setTimeout(tryOpen,80); return; }
      setStatus("sendStatus","接続できません","err"); setNet(false);
    });
    peer.on("disconnected",()=>{ if(!senderTransferring)setNet(false); });
  };
  tryOpen();
}

function wireSenderConn(conn){
  conn.on("open",async()=>{
    senderTransferring=true; clearInterval(senderTimer); $("sendTtl").textContent="接続"; setStatus("sendStatus","接続中");
    try{
      const p=await senderPayloadPromise;
      conn.send({t:"meta",name:p.name,size:p.blob.size,count:p.count,chunk:CHUNK,total:Math.ceil(p.blob.size/CHUNK)});
    }catch{try{conn.close()}catch{}}
  });
  conn.on("data",data=>{
    if(!data||typeof data!=="object")return;
    if(data.t==="ready") sendPayload(conn).catch(()=>setStatus("sendStatus","送信失敗","err"));
    if(data.t==="ack") { lastAck=Math.max(lastAck,Number(data.i)||0); const keep=[]; for(const w of ackWaiters){ if(lastAck>=w.target)w.resolve(); else keep.push(w); } ackWaiters=keep; }
    if(data.t==="done"){ setProgress("send",100,true); setStatus("sendStatus","完了","ok"); setTimeout(()=>{try{conn.close()}catch{}},300); }
    if(data.t==="cancel") setStatus("sendStatus","中止","err");
  });
  conn.on("close",()=>{ senderConn=null; if(senderTransferring && $("sendStatus").textContent!=="完了")setStatus("sendStatus","切断","err"); senderTransferring=false; });
  conn.on("error",()=>setStatus("sendStatus","送信失敗","err"));
}
function waitAck(target,timeout=30000){
  if(lastAck>=target)return Promise.resolve();
  return new Promise((resolve,reject)=>{ const rec={target,resolve:()=>{clearTimeout(t);resolve();}}; const t=setTimeout(()=>{ackWaiters=ackWaiters.filter(x=>x!==rec);reject(new Error("ACK timeout"));},timeout); ackWaiters.push(rec); });
}
async function waitBuffer(conn){
  const dc=conn.dataChannel || conn._dc;
  if(!dc)return;
  while(dc.bufferedAmount>2*1024*1024) await sleep(12);
}
async function sendPayload(conn){
  const p=await senderPayloadPromise; const total=Math.ceil(p.blob.size/CHUNK); lastAck=-1; ackWaiters=[];
  setStatus("sendStatus","送信中"); setProgress("send",0,true);
  for(let i=0;i<total;i++){
    const start=i*CHUNK,end=Math.min(p.blob.size,start+CHUNK); const b=await p.blob.slice(start,end).arrayBuffer();
    conn.send({t:"chunk",i,b});
    if(i%WINDOW===WINDOW-1 || i===total-1){ await waitBuffer(conn); await waitAck(i); }
    setProgress("send",((i+1)/total)*100,true);
  }
  conn.send({t:"eof",total});
  setStatus("sendStatus","確認中");
}

function cleanupReceiver(){
  try{recvConn?.close()}catch{};try{recvPeer?.destroy()}catch{};try{recvWriter?.abort()}catch{};
  recvConn=null;recvPeer=null;recvDir=null;recvWriter=null;recvParts=[];recvMeta=null;recvBytes=0;recvChunks=0;recvQueue=Promise.resolve();
  if(recvObjectUrl){URL.revokeObjectURL(recvObjectUrl);recvObjectUrl=null;}
  $("recvIncoming").classList.remove("show"); $("recvSave").classList.remove("show"); setProgress("recv",0,false); setNet(false);
}
async function uniqueNameInDir(dir,name){
  const clean=safeBase(name.replace(/\.zip$/i,""))+(/\.zip$/i.test(name)?".zip":"");
  let candidate=clean; let i=1; const dot=clean.lastIndexOf(".");
  while(true){try{await dir.getFileHandle(candidate); candidate=dot>0?`${clean.slice(0,dot)} (${i++})${clean.slice(dot)}`:`${clean} (${i++})`;}catch{return candidate;}}
}
async function startReceive(){
  const code=$("recvCode").value.replace(/\D/g,"").slice(0,6); $("recvCode").value=code; if(code.length!==6){setStatus("recvStatus","6桁","err");return;}
  cleanupReceiver(); setStatus("recvStatus","接続中");
  if("showDirectoryPicker" in window){
    try{recvDir=await showDirectoryPicker({mode:"readwrite"});}catch{setStatus("recvStatus","");return;}
  }
  if(!window.Peer){setStatus("recvStatus","接続機能を読み込めません","err");return;}
  const peer=new Peer(undefined,{debug:1}); recvPeer=peer;
  peer.on("open",()=>{
    setNet(true); const conn=peer.connect(`tsuru-${code}`,{reliable:true,serialization:"binary"}); recvConn=conn; wireReceiverConn(conn);
  });
  peer.on("error",()=>{setStatus("recvStatus","見つかりません","err");setNet(false)});
}
function wireReceiverConn(conn){
  conn.on("open",()=>setStatus("recvStatus","接続中"));
  conn.on("data",data=>{
    if(!data||typeof data!=="object")return;
    if(data.t==="meta") onRecvMeta(data,conn);
    if(data.t==="chunk") recvQueue=recvQueue.then(()=>onRecvChunk(data,conn)).catch(()=>{try{conn.send({t:"cancel"})}catch{};setStatus("recvStatus","受信失敗","err")});
    if(data.t==="eof") recvQueue=recvQueue.then(()=>finishReceive(conn)).catch(()=>setStatus("recvStatus","保存失敗","err"));
  });
  conn.on("close",()=>{if($("recvStatus").textContent!=="完了" && recvMeta)setStatus("recvStatus","切断","err")});
  conn.on("error",()=>setStatus("recvStatus","受信失敗","err"));
}
async function onRecvMeta(meta,conn){
  recvMeta=meta; recvBytes=0; recvChunks=0; recvParts=[];
  $("recvName").textContent=meta.name||"TSURU.zip"; $("recvMeta").textContent=`${meta.count||0}件  ·  ${fmtBytes(meta.size||0)}`; $("recvIncoming").classList.add("show"); setProgress("recv",0,true);
  if(recvDir){
    const name=await uniqueNameInDir(recvDir,meta.name||`TSURU-${dateStamp()}.zip`); const fh=await recvDir.getFileHandle(name,{create:true}); recvWriter=await fh.createWritable();
  }
  setStatus("recvStatus","受信中"); conn.send({t:"ready"});
}
async function onRecvChunk(data,conn){
  if(!recvMeta)return; const b=data.b instanceof ArrayBuffer?data.b:(data.b?.buffer||data.b); if(!b)return;
  const u=new Uint8Array(b); if(recvWriter) await recvWriter.write(u); else recvParts.push(u.slice());
  recvBytes+=u.byteLength; recvChunks++; setProgress("recv",recvMeta.size?recvBytes/recvMeta.size*100:0,true);
  if(data.i%WINDOW===WINDOW-1 || data.i===recvMeta.total-1) conn.send({t:"ack",i:data.i});
}
async function finishReceive(conn){
  if(!recvMeta)return;
  if(recvWriter){await recvWriter.close();recvWriter=null;} else {
    const blob=new Blob(recvParts,{type:"application/zip"}); recvParts=[]; recvObjectUrl=URL.createObjectURL(blob); const a=$("recvSave"); a.href=recvObjectUrl; a.download=recvMeta.name||`TSURU-${dateStamp()}.zip`; a.classList.add("show");
    a.onclick=async e=>{ if(navigator.canShare && navigator.share){ const f=new File([blob],a.download,{type:"application/zip"}); if(navigator.canShare({files:[f]})){e.preventDefault();try{await navigator.share({files:[f]});}catch{} }} };
  }
  setProgress("recv",100,true); setStatus("recvStatus","完了","ok"); conn.send({t:"done"}); setTimeout(()=>{try{conn.close()}catch{}},500);
}

async function saveBlob(blob,name){
  if("showSaveFilePicker" in window){
    const h=await showSaveFilePicker({suggestedName:name,types:[{description:"ZIP",accept:{"application/zip":[".zip"]}}]}); const w=await h.createWritable(); await w.write(blob); await w.close(); return true;
  }
  const u=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),60000); return true;
}

function showZipMode(mode){
  $("zipChoice").classList.add("hidden"); $("zipWork").classList.add("show"); $("packUi").classList.toggle("hidden",mode!=="pack"); $("unpackUi").classList.toggle("hidden",mode!=="unpack"); $("zipModeLabel").textContent=mode==="pack"?"まとめる":"展開";
}
function resetZip(){ $("zipChoice").classList.remove("hidden"); $("zipWork").classList.remove("show"); $("packUi").classList.add("hidden");$("unpackUi").classList.add("hidden"); }
function setPackEntries(entries){packEntries=entries.filter(e=>e.file && !e.file.name.startsWith("."));renderBundle("pack",packEntries);$("packSave").disabled=!packEntries.length;setProgress("pack",0,false);setStatus("packStatus","");}
async function packSave(){
  if(!packEntries.length)return; $("packSave").disabled=true;setStatus("packStatus","作成中");setProgress("pack",0,true);
  try{const blob=await makeZip(packEntries,p=>setProgress("pack",p,true));await saveBlob(blob,packageName(packEntries));setStatus("packStatus","完了","ok");setProgress("pack",100,true);}catch(e){setStatus("packStatus",e?.name==="AbortError"?"":(e.message||"失敗"),e?.name==="AbortError"?"":"err");}finally{$("packSave").disabled=false;}
}
async function setUnpackFile(file){
  unpackFile=file||null; if(!file){$("unpackBundle").classList.remove("show");$("unpackRun").disabled=true;setStatus("unpackStatus","");return;}
  $("unpackName").textContent=file.name; $("unpackMeta").textContent=fmtBytes(file.size); $("unpackBundle").classList.add("show"); $("unpackRun").disabled=false; setStatus("unpackStatus","確認中");
  try{const z=await JSZip.loadAsync(file);const count=Object.values(z.files).filter(x=>!x.dir).length;$("unpackMeta").textContent=`${count}件  ·  ${fmtBytes(file.size)}`;setStatus("unpackStatus","");}catch{setStatus("unpackStatus","ZIPではありません","err");$("unpackRun").disabled=true;}
}
function safeZipPath(p){
  p=(p||"").replace(/\\/g,"/").replace(/^\/+/,""); const out=[]; for(const part of p.split("/")){if(!part||part===".")continue;if(part==="..")continue;out.push(part.replace(/[<>:"|?*\x00-\x1f]/g,"_"));} return out.join("/");
}
async function ensureDir(root,parts){let d=root;for(const p of parts){d=await d.getDirectoryHandle(p,{create:true});}return d;}
async function unpackRun(){
  if(!unpackFile)return; if(!("showDirectoryPicker" in window)){setStatus("unpackStatus","PCのChrome / Edgeで展開","err");return;}
  let dir;try{dir=await showDirectoryPicker({mode:"readwrite"});}catch{return;}
  $("unpackRun").disabled=true;setStatus("unpackStatus","展開中");setProgress("unpack",0,true);
  try{
    const z=await JSZip.loadAsync(unpackFile); const files=Object.values(z.files).filter(x=>!x.dir); let i=0;
    for(const f of files){const path=safeZipPath(f.name);if(!path)continue;const parts=path.split("/");const name=parts.pop();const target=await ensureDir(dir,parts);const fh=await target.getFileHandle(name,{create:true});const w=await fh.createWritable();const data=await f.async("uint8array");await w.write(data);await w.close();i++;setProgress("unpack",i/files.length*100,true);}
    setStatus("unpackStatus","完了","ok");
  }catch(e){setStatus("unpackStatus",e.message||"展開失敗","err");}finally{$("unpackRun").disabled=false;}
}

function init(){
  bindTabs();
  $("sendFilesBtn").onclick=()=>$("sendFiles").click(); $("sendFolderBtn").onclick=()=>$("sendFolder").click();
  $("sendFiles").onchange=()=>{setSendEntries(filesToEntries($("sendFiles").files));$("sendFiles").value=""};
  $("sendFolder").onchange=()=>{setSendEntries(filesToEntries($("sendFolder").files));$("sendFolder").value=""};
  $("sendClear").onclick=clearSend; bindDrop($("sendPick"),setSendEntries);
  $("recvCode").addEventListener("input",()=>{$("recvCode").value=$("recvCode").value.replace(/\D/g,"").slice(0,6)}); $("recvCode").addEventListener("keydown",e=>{if(e.key==="Enter")startReceive()}); $("recvBtn").onclick=startReceive;

  $("packChoice").onclick=()=>showZipMode("pack"); $("unpackChoice").onclick=()=>showZipMode("unpack"); $("zipBack").onclick=resetZip;
  $("packFilesBtn").onclick=()=>$("packFiles").click();$("packFolderBtn").onclick=()=>$("packFolder").click();
  $("packFiles").onchange=()=>{setPackEntries(filesToEntries($("packFiles").files));$("packFiles").value=""}; $("packFolder").onchange=()=>{setPackEntries(filesToEntries($("packFolder").files));$("packFolder").value=""};
  $("packClear").onclick=()=>setPackEntries([]); $("packSave").onclick=packSave; bindDrop($("packPick"),setPackEntries);
  $("unpackFileBtn").onclick=()=>$("unpackFile").click(); $("unpackFile").onchange=()=>{setUnpackFile($("unpackFile").files[0]);$("unpackFile").value=""}; $("unpackClear").onclick=()=>setUnpackFile(null); $("unpackRun").onclick=unpackRun; bindDrop($("unpackPick"),setUnpackFile,true);
  window.addEventListener("beforeunload",()=>{try{senderPeer?.destroy()}catch{};try{recvPeer?.destroy()}catch{}});
}
init();
