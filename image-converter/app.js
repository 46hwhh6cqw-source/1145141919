"use strict";

/* ================================================================
   設定（localStorage に保存。どの画面サイズでも共有される）
   ================================================================ */

const SETTINGS_KEY = "imgconv.settings.v1";
const DEFAULTS = {
  fmt: "image/jpeg",
  quality: 92,
  maxEdge: 0,
  keepExif: true,
  stripGps: false,
  launchAction: "convert",     // 画像を受け取ったとき: add | convert | convertSave
  saveMode: "each",            // 自動保存: each | zip
  dest: "download",            // 保存先: download | folder
  ui: "full",                  // full | compact
};
const settings = Object.assign({}, DEFAULTS, (() => {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
})());
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}
window.__settings = settings; // テスト用フック

/* ================================================================
   フォルダへの直接保存（File System Access API / Chrome・Edge）
   ダウンロード履歴を残さずに書き込める。フォルダごとドロップされた
   画像は元のフォルダへ、それ以外は指定した保存先フォルダへ。
   ================================================================ */

const FS_OK = "showDirectoryPicker" in window;

const idb = {
  open: () => new Promise((res, rej) => {
    const r = indexedDB.open("imgconv", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }),
  async set(k, v) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(v, k);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
  async get(k) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const rq = db.transaction("kv", "readonly").objectStore("kv").get(k);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  },
};

let outDirHandle = null; // 指定した保存先フォルダ（IndexedDB で永続化）

async function loadOutDir() {
  if (!FS_OK) return;
  try { outDirHandle = (await idb.get("outDir")) || null; } catch {}
}

async function ensureWritable(handle) {
  if (!handle) return false;
  try {
    if (!handle.queryPermission) return true; // OPFS などは常に書き込み可
    if (await handle.queryPermission({ mode: "readwrite" }) === "granted") return true;
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  } catch { return false; }
}

async function writeToDir(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

// 既存ファイルを壊さない: 同名があれば "-conv" 付きにする（-conv 名は上書きOK）
async function uniqueName(dir, name) {
  try { await dir.getFileHandle(name); } catch { return name; }
  const dot = name.lastIndexOf(".");
  return name.slice(0, dot) + "-conv" + name.slice(dot);
}

// 変換結果をフォルダへ直接保存。成功で true
async function saveItemToFolder(item) {
  const dir = item.srcDir || outDirHandle;
  if (!dir || !(await ensureWritable(dir))) return false;
  try {
    const name = await uniqueName(dir, item.result.name);
    await writeToDir(dir, name, item.result.blob);
    item.saved = true;
    setStatus(item.refs, "done", "保存済");
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/* ================================================================
   UI
   ================================================================ */

const state = {
  items: [],       // { file, li, refs, result, url, saved }
  running: false,
};
window.__conv = state; // テスト用フック

const $ = id => document.getElementById(id);
const drop = $("drop"), fileInput = $("fileInput"), list = $("list");
const convertBtn = $("convertBtn"), zipBtn = $("zipBtn"), clearBtn = $("clearBtn");

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const KIND_LABEL = { heic: "HEIC", avif: "AVIF", jpeg: "JPG", png: "PNG", webp: "WebP", gif: "GIF", bmp: "BMP", unknown: "?" };

function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

function outName(name, mime, taken) {
  const base = name.replace(/\.[^.]+$/, "");
  let candidate = base + "." + EXT[mime];
  if (candidate === name) candidate = base + "-conv." + EXT[mime];
  let i = 1;
  while (taken.has(candidate)) candidate = base + " (" + (i++) + ")." + EXT[mime];
  taken.add(candidate);
  return candidate;
}

function parseExifDate(s) { // "YYYY:MM:DD HH:MM:SS" → Date (ローカル時刻)
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || "");
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(d) ? null : d;
}

function ensureHead() {
  if (list.querySelector(".head")) return;
  const head = document.createElement("li");
  head.className = "head";
  head.innerHTML = "<span></span><span>ファイル</span><span>撮影日時</span><span>サイズ</span><span>EXIF</span><span>状態</span><span></span>";
  list.appendChild(head);
}

// files: File の配列/FileList、または { file, srcDir? } の配列
function addFiles(files) {
  ensureHead();
  for (const entry of files) {
    const file = entry && entry.file instanceof File ? entry.file : entry;
    const srcDir = (entry && entry.srcDir) || null;
    if (!(file instanceof File) || !file.size) continue;
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML =
      '<img class="thumb" alt="" />' +
      '<div><div class="fname"></div><div class="ftype"></div></div>' +
      '<div class="c-date"><span class="t">—</span></div>' +
      '<div class="c-size"></div>' +
      '<div class="c-exif">—</div>' +
      '<div><span class="status wait">待機中</span></div>' +
      '<div class="c-act"></div>';
    const refs = {
      thumb: li.querySelector(".thumb"),
      name: li.querySelector(".fname"),
      type: li.querySelector(".ftype"),
      date: li.querySelector(".c-date"),
      size: li.querySelector(".c-size"),
      meta: li.querySelector(".c-exif"),
      status: li.querySelector(".status"),
      act: li.querySelector(".c-act"),
    };
    refs.name.textContent = file.name;
    refs.size.innerHTML = '<span class="muted">' + fmtBytes(file.size) + "</span>";
    list.appendChild(li);
    state.items.push({ file, srcDir, li, refs, result: null, url: null, saved: false });
  }
  refreshButtons();
}

function setStatus(refs, cls, text) {
  refs.status.className = "status " + cls;
  refs.status.textContent = text;
}

function refreshButtons() {
  const has = state.items.length > 0;
  convertBtn.disabled = !has || state.running;
  clearBtn.disabled = !has || state.running;
  const done = state.items.filter(it => it.result).length;
  zipBtn.hidden = done < 2 || state.running;
  $("summary").textContent = has
    ? state.items.length + " 件" + (done ? " / " + done + " 件変換済み" : "")
    : "";
}

function currentOpts() {
  return {
    mime: settings.fmt,
    quality: settings.quality / 100,
    maxEdge: settings.maxEdge,
    keepExif: settings.keepExif,
    stripGps: settings.stripGps,
  };
}

// onlyPending: true なら未変換のファイルだけ変換する（ファイル起動時の追加分用）
async function runConvert(onlyPending) {
  if (state.running) return;
  state.running = true;
  refreshButtons();
  const opts = currentOpts();
  const taken = new Set();
  for (const it of state.items) if (it.result && onlyPending) taken.add(it.result.name);
  let idx = 0;
  for (const item of state.items) {
    idx++;
    if (item.result && onlyPending) continue;
    if (item.url) { URL.revokeObjectURL(item.url); item.url = null; item.result = null; item.saved = false; }
    setStatus(item.refs, "run", "変換中 " + idx + "/" + state.items.length);
    try {
      const r = await convertOne(item, opts);
      r.name = outName(item.file.name, opts.mime, taken);
      item.result = r;
      item.url = URL.createObjectURL(r.blob);
      item.refs.thumb.src = item.url;

      item.refs.type.textContent =
        KIND_LABEL[r.kind] + " → " + EXT[opts.mime].toUpperCase() + " · " +
        (r.srcW !== r.width ? r.srcW + "×" + r.srcH + " → " : "") + r.width + "×" + r.height;
      item.refs.date.innerHTML = r.shotDate
        ? "<b>" + r.shotDate.replace(/^(\d{4}):(\d{2}):/, "$1/$2/").replace(":", "/") + "</b>"
        : '<span class="t">—</span>';
      item.refs.size.innerHTML =
        '<span class="muted">' + fmtBytes(item.file.size) + " →</span> <b>" + fmtBytes(r.blob.size) + "</b>";
      item.refs.meta.innerHTML = r.exifKept
        ? '<span class="keep">' + (r.gpsRemoved ? "保持 / GPS削除✓" : (r.hadGps ? "保持（GPS含む）" : "保持")) + "</span>"
        : (r.shotDate ? "なし（保持オフ）" : "元画像になし");

      setStatus(item.refs, "done", "完了");
      let a = item.refs.act.querySelector("a.dl");
      if (!a) {
        a = document.createElement("a");
        a.className = "dl";
        a.textContent = "保存";
        // フォルダ直接保存モードではダウンロードせずフォルダへ書き込む
        a.addEventListener("click", async e => {
          if (settings.dest !== "folder" || !FS_OK || !item.result) return;
          e.preventDefault();
          if (!(await saveItemToFolder(item))) {
            const tmp = document.createElement("a");
            tmp.href = item.url;
            tmp.download = item.result.name;
            tmp.click();
          }
        });
        item.refs.act.appendChild(a);
      }
      a.href = item.url;
      a.download = r.name;
    } catch (err) {
      console.error(err);
      setStatus(item.refs, "err", "エラー");
      item.refs.meta.innerHTML = '<span class="warn"></span>';
      item.refs.meta.firstChild.textContent = (err && err.message) || "変換に失敗しました";
    }
    refreshButtons();
  }
  state.running = false;
  refreshButtons();
}

function zipName() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  return "converted_" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
    "_" + pad(now.getHours()) + pad(now.getMinutes()) + ".zip";
}

async function downloadZip() {
  const done = state.items.filter(it => it.result);
  if (!done.length) return;
  zipBtn.disabled = true;
  zipBtn.textContent = "ZIP作成中…";
  try {
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    for (const it of done) {
      let date = parseExifDate(it.result.shotDate) || new Date(it.file.lastModified);
      // JSZip は UTC で書き込むため、ローカル時刻がそのまま残るよう補正する
      date = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
      zip.file(it.result.name, it.result.blob, { date });
    }
    const blob = await zip.generateAsync({ type: "blob" });
    let written = false;
    if (settings.dest === "folder" && FS_OK && outDirHandle && await ensureWritable(outDirHandle)) {
      try { await writeToDir(outDirHandle, zipName(), blob); written = true; } catch {}
    }
    if (!written) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = zipName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    done.forEach(it => { it.saved = true; });
  } catch (err) {
    alert("ZIPの作成に失敗しました: " + ((err && err.message) || err));
  }
  zipBtn.disabled = false;
  zipBtn.textContent = "ZIP保存";
}

// 自動保存: フォルダ直接保存 → 残りは個別ダウンロード or ZIP
async function autoSave() {
  let todo = state.items.filter(it => it.result && !it.saved);
  if (!todo.length) return;

  if (settings.dest === "folder" && FS_OK) {
    const rest = [];
    for (const it of todo) {
      if (!(await saveItemToFolder(it))) rest.push(it);
    }
    todo = rest;
    if (!todo.length) return;
  }

  if (settings.saveMode === "zip" && todo.length > 1) {
    await downloadZip();
  } else {
    for (const it of todo) {
      const a = document.createElement("a");
      a.href = it.url;
      a.download = it.result.name;
      a.click();
      it.saved = true;
      await new Promise(r => setTimeout(r, 250)); // 連続ダウンロードの取りこぼし防止
    }
  }
  for (const it of state.items) {
    if (it.saved && it.result) setStatus(it.refs, "done", "保存済");
  }
}

/* ================================================================
   画像の受け取り
   （ドロップ / 貼り付け / ファイル選択 / ダブルクリック起動）
   ================================================================ */

let incomingChain = Promise.resolve();
function handleIncoming(entries) {
  incomingChain = incomingChain.then(async () => {
    addFiles(entries);
    if (settings.launchAction === "add") return;
    await runConvert(true);
    if (settings.launchAction === "convertSave") await autoSave();
  });
  return incomingChain;
}
window.__handleIncoming = handleIncoming; // テスト用フック
window.__handleLaunchFiles = files => handleIncoming(Array.from(files).map(f => ({ file: f })));

if ("launchQueue" in window) {
  launchQueue.setConsumer(params => {
    if (!params.files || !params.files.length) return;
    Promise.all(params.files.map(h => h.getFile()))
      .then(files => handleIncoming(files.map(f => ({ file: f }))));
  });
}

const IMG_RE = /\.(heic|heif|jpe?g|png|webp|gif|bmp|avif)$/i;

// ドロップされたものを {file, srcDir?} に展開。フォルダは中の画像を集め、
// 書き込み許可をユーザー操作中に取っておく（元のフォルダへの直接保存用）
async function collectDropped(dt) {
  const out = [];
  const items = Array.from(dt.items || []);
  const canHandle = FS_OK && items.some(i => typeof i.getAsFileSystemHandle === "function");
  if (canHandle) {
    // await すると DataTransfer が無効になるため、ハンドル要求は先に同期で行う
    const promises = items.filter(i => i.kind === "file").map(i => i.getAsFileSystemHandle());
    for (const p of promises) {
      let h = null;
      try { h = await p; } catch {}
      if (!h) continue;
      if (h.kind === "file") {
        try { out.push({ file: await h.getFile() }); } catch {}
      } else if (h.kind === "directory") {
        if (settings.dest === "folder") await ensureWritable(h);
        const inDir = [];
        try {
          for await (const entry of h.values()) {
            if (entry.kind === "file" && IMG_RE.test(entry.name)) {
              try { inDir.push({ file: await entry.getFile(), srcDir: h }); } catch {}
            }
          }
        } catch {}
        inDir.sort((a, b) => a.file.name.localeCompare(b.file.name, "ja"));
        out.push(...inDir);
      }
    }
  } else {
    for (const f of Array.from(dt.files || [])) out.push({ file: f });
  }
  return out;
}

/* ================================================================
   画面サイズモード（full / compact）
   ================================================================ */

function setUi(mode, resize) {
  settings.ui = mode;
  saveSettings();
  document.body.classList.toggle("compact", mode === "compact");
  document.body.classList.remove("settings-open");
  segSync("uiSeg", mode);
  if (resize && window.matchMedia("(display-mode: standalone)").matches) {
    try {
      if (mode === "compact") window.resizeTo(460, 620);
      else window.resizeTo(1180, 840);
    } catch {}
  }
}

/* ================================================================
   イベント / 初期化
   ================================================================ */

function segSync(id, value) {
  document.querySelectorAll("#" + id + " button").forEach(b =>
    b.classList.toggle("on", b.dataset.v === String(value)));
}

function bindSeg(id, apply) {
  $(id).addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    apply(b.dataset.v);
    segSync(id, b.dataset.v);
    saveSettings();
  });
}

drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", () => {
  handleIncoming(Array.from(fileInput.files).map(f => ({ file: f })));
  fileInput.value = "";
});

// ページ全体をドロップ先にする
let dragDepth = 0;
document.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; drop.classList.add("over"); });
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("dragleave", e => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove("over"); }
});
document.addEventListener("drop", e => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove("over");
  if (!e.dataTransfer) return;
  collectDropped(e.dataTransfer).then(entries => { if (entries.length) handleIncoming(entries); });
});

// Ctrl+V でクリップボードの画像を追加
document.addEventListener("paste", e => {
  const files = Array.from((e.clipboardData && e.clipboardData.files) || [])
    .filter(f => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  if (files.length) handleIncoming(files.map(f => ({ file: f })));
});

bindSeg("fmtSeg", v => {
  settings.fmt = v;
  $("qualityRow").style.opacity = v === "image/png" ? .4 : 1;
});
bindSeg("sizeSeg", v => { settings.maxEdge = +v; });
bindSeg("launchSeg", v => { settings.launchAction = v; });
bindSeg("saveSeg", v => { settings.saveMode = v; });

// 保存先の切替。「フォルダに直接」はクリックのたびにフォルダを選び直せる
function updateDestUi() {
  segSync("destSeg", settings.dest);
  $("saveRow").style.display = settings.dest === "folder" ? "none" : "";
  $("destInfo").textContent = settings.dest === "folder"
    ? "保存先: " + (outDirHandle ? outDirHandle.name : "未選択（もう一度押して選択）") +
      "／フォルダごとドロップした分は元のフォルダへ"
    : "";
}
$("destSeg").addEventListener("click", async e => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.v === "folder") {
    if (!FS_OK) return;
    try {
      const h = await showDirectoryPicker({ mode: "readwrite" });
      outDirHandle = h;
      idb.set("outDir", h).catch(() => {});
      settings.dest = "folder";
    } catch { /* キャンセル時は変更しない */ }
  } else {
    settings.dest = "download";
  }
  saveSettings();
  updateDestUi();
});
bindSeg("uiSeg", v => setUi(v, true));

$("quality").addEventListener("input", e => {
  settings.quality = +e.target.value;
  $("qVal").textContent = e.target.value + "%";
  saveSettings();
});
$("keepExif").addEventListener("change", e => { settings.keepExif = e.target.checked; saveSettings(); });
$("stripGps").addEventListener("change", e => { settings.stripGps = e.target.checked; saveSettings(); });

convertBtn.addEventListener("click", () => runConvert(false));
zipBtn.addEventListener("click", downloadZip);
clearBtn.addEventListener("click", () => {
  for (const it of state.items) if (it.url) URL.revokeObjectURL(it.url);
  state.items = [];
  list.innerHTML = "";
  refreshButtons();
});

// 小さい画面用: ⚙ で設定パネルを出し入れ
$("gearBtn").addEventListener("click", e => {
  e.stopPropagation();
  document.body.classList.toggle("settings-open");
});
document.addEventListener("click", e => {
  if (document.body.classList.contains("settings-open") &&
      !e.target.closest("aside.panel") && !e.target.closest("#gearBtn")) {
    document.body.classList.remove("settings-open");
  }
});

// アプリとしてインストール
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  $("installBtn").hidden = false;
});
$("installBtn").addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice.catch(() => {});
  deferredPrompt = null;
  $("installBtn").hidden = true;
});
window.addEventListener("appinstalled", () => { $("installBtn").hidden = true; });

// ポータブル版（単一HTML・file://起動）ではインストールボタンを隠す
const PORTABLE = !!window.__PORTABLE__;
if (PORTABLE) {
  $("installBtn").style.display = "none";
}

if (!PORTABLE && "serviceWorker" in navigator &&
    (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

// 初期状態の反映
(function init() {
  segSync("fmtSeg", settings.fmt);
  segSync("sizeSeg", settings.maxEdge);
  segSync("launchSeg", settings.launchAction);
  segSync("saveSeg", settings.saveMode);
  $("quality").value = settings.quality;
  $("qVal").textContent = settings.quality + "%";
  $("qualityRow").style.opacity = settings.fmt === "image/png" ? .4 : 1;
  $("keepExif").checked = settings.keepExif;
  $("stripGps").checked = settings.stripGps;

  if (FS_OK) {
    loadOutDir().then(updateDestUi);
  } else {
    settings.dest = "download";
    $("destRow").style.display = "none";
  }
  updateDestUi();
  window.__setOutDir = h => { outDirHandle = h; updateDestUi(); }; // テスト用フック

  const urlUi = new URLSearchParams(location.search).get("ui");
  setUi(urlUi === "compact" || urlUi === "full" ? urlUi : settings.ui, false);
})();
