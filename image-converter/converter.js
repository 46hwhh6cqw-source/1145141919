"use strict";

/* ================================================================
   変換エンジン（UIなし）
   EXIF(TIFF) バイナリユーティリティ:
   元ファイルからEXIFのTIFFブロックを生のまま取り出し、変換後の
   JPG / PNG / WebP に埋め込み直す。値を再構築しないので
   撮影日時・GPS・カメラ情報などが欠けずにそのまま残る。
   ================================================================ */

const TYPE_SIZE = { 1:1, 2:1, 3:2, 4:4, 5:8, 6:1, 7:1, 8:2, 9:4, 10:8, 11:4, 12:8 };

function tiffOpen(buf) {
  if (buf.byteLength < 8) return null;
  const dv = new DataView(buf);
  const m = dv.getUint16(0);
  const le = m === 0x4949 ? true : m === 0x4D4D ? false : null;
  if (le === null || dv.getUint16(2, le) !== 0x002A) return null;
  return { dv, le, ifd0: dv.getUint32(4, le) };
}

function tiffEntries(t, off) {
  const out = [];
  if (off <= 0 || off + 2 > t.dv.byteLength) return out;
  const n = t.dv.getUint16(off, t.le);
  for (let i = 0; i < n; i++) {
    const eo = off + 2 + i * 12;
    if (eo + 12 > t.dv.byteLength) break;
    out.push({
      tag: t.dv.getUint16(eo, t.le),
      type: t.dv.getUint16(eo + 2, t.le),
      count: t.dv.getUint32(eo + 4, t.le),
      eo,
    });
  }
  return out;
}

function tiffValueOffset(t, e) {
  const size = (TYPE_SIZE[e.type] || 1) * e.count;
  return size <= 4 ? e.eo + 8 : t.dv.getUint32(e.eo + 8, t.le);
}

function tiffAscii(t, e) {
  const off = tiffValueOffset(t, e);
  let s = "";
  for (let i = 0; i < e.count && off + i < t.dv.byteLength; i++) {
    const c = t.dv.getUint8(off + i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// 撮影日時 (DateTimeOriginal → CreateDate → DateTime) を "YYYY:MM:DD HH:MM:SS" で返す
function exifDate(tiffBuf) {
  try {
    const t = tiffOpen(tiffBuf);
    if (!t) return null;
    const ifd0 = tiffEntries(t, t.ifd0);
    const exifPtr = ifd0.find(e => e.tag === 0x8769);
    if (exifPtr) {
      const sub = tiffEntries(t, t.dv.getUint32(exifPtr.eo + 8, t.le));
      const d = sub.find(e => e.tag === 0x9003) || sub.find(e => e.tag === 0x9004);
      if (d && d.type === 2) return tiffAscii(t, d) || null;
    }
    const d0 = ifd0.find(e => e.tag === 0x0132);
    return d0 && d0.type === 2 ? (tiffAscii(t, d0) || null) : null;
  } catch { return null; }
}

function exifHasGps(tiffBuf) {
  try {
    const t = tiffOpen(tiffBuf);
    return !!(t && tiffEntries(t, t.ifd0).some(e => e.tag === 0x8825));
  } catch { return false; }
}

// デコード時に回転を反映済みなので Orientation タグを 1（正位置）に直す
function normalizeOrientation(tiffBuf) {
  const t = tiffOpen(tiffBuf);
  if (!t) return;
  const e = tiffEntries(t, t.ifd0).find(e => e.tag === 0x0112);
  if (e && e.type === 3 && e.count === 1) t.dv.setUint16(e.eo + 8, 1, t.le);
}

// GPS IFD の中身をゼロ埋めし、IFD0 から GPS ポインタのエントリを取り除く。
// 失敗時は false（呼び出し側で EXIF ごと破棄して安全側に倒す）
function stripGps(tiffBuf) {
  const t = tiffOpen(tiffBuf);
  if (!t) return false;
  const dv = t.dv, le = t.le, len = dv.byteLength;
  if (t.ifd0 + 2 > len) return false;
  const n = dv.getUint16(t.ifd0, le);
  const ifdEnd = t.ifd0 + 2 + n * 12 + 4; // 次IFDポインタまで含む
  if (ifdEnd > len) return false;
  const ents = tiffEntries(t, t.ifd0);
  const gi = ents.findIndex(e => e.tag === 0x8825);
  if (gi < 0) return true;
  const g = ents[gi];
  const gpsOff = dv.getUint32(g.eo + 8, le);
  if (gpsOff > 0 && gpsOff + 2 <= len) {
    const ge = tiffEntries(t, gpsOff);
    for (const e of ge) {
      const size = (TYPE_SIZE[e.type] || 1) * e.count;
      if (size > 4) {
        const off = dv.getUint32(e.eo + 8, le);
        for (let i = 0; i < size && off + i < len; i++) dv.setUint8(off + i, 0);
      }
    }
    const region = Math.min(2 + ge.length * 12 + 4, len - gpsOff);
    for (let i = 0; i < region; i++) dv.setUint8(gpsOff + i, 0);
  }
  const u = new Uint8Array(tiffBuf);
  u.copyWithin(g.eo, g.eo + 12, ifdEnd);
  u.fill(0, ifdEnd - 12, ifdEnd);
  dv.setUint16(t.ifd0, n - 1, le);
  return true;
}

/* ---------- 各コンテナからの EXIF 抽出 ---------- */

// HEIC / AVIF (ISO-BMFF): meta → iinf で Exif アイテムIDを探し、iloc で位置を引く
function exifFromIsoBmff(buf) {
  const dv = new DataView(buf);
  const len = buf.byteLength;
  const cc = o => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  const boxSize = p => {
    let size = dv.getUint32(p), hdr = 8;
    if (size === 1) {
      if (p + 16 > len) return null;
      size = dv.getUint32(p + 8) * 2 ** 32 + dv.getUint32(p + 12);
      hdr = 16;
    }
    return size >= hdr ? { size, hdr } : null;
  };

  let metaStart = -1, metaEnd = -1;
  for (let p = 0; p + 8 <= len;) {
    const b = boxSize(p);
    if (!b) break;
    const size = b.size === 0 ? len - p : b.size;
    if (cc(p + 4) === "meta") { metaStart = p + b.hdr + 4; metaEnd = p + size; break; }
    p += size;
  }
  if (metaStart < 0) return null;

  let iinf = null, iloc = null;
  for (let p = metaStart; p + 8 <= metaEnd;) {
    const b = boxSize(p);
    if (!b) break;
    const size = b.size === 0 ? metaEnd - p : b.size;
    const type = cc(p + 4);
    if (type === "iinf") iinf = { o: p + b.hdr, end: p + size };
    if (type === "iloc") iloc = { o: p + b.hdr, end: p + size };
    p += size;
  }
  if (!iinf || !iloc) return null;

  let exifId = null;
  {
    const ver = dv.getUint8(iinf.o);
    let q = iinf.o + 4;
    const count = ver === 0 ? dv.getUint16(q) : dv.getUint32(q);
    q += ver === 0 ? 2 : 4;
    for (let i = 0; i < count && q + 8 <= iinf.end; i++) {
      const b = boxSize(q);
      if (!b) break;
      if (cc(q + 4) === "infe") {
        const v = dv.getUint8(q + b.hdr);
        if (v >= 2) {
          let r = q + b.hdr + 4;
          const id = v === 2 ? dv.getUint16(r) : dv.getUint32(r);
          r += (v === 2 ? 2 : 4) + 2; // item_ID + protection_index
          if (cc(r) === "Exif") { exifId = id; break; }
        }
      }
      q += b.size === 0 ? iinf.end - q : b.size;
    }
  }
  if (exifId === null) return null;

  {
    const ver = dv.getUint8(iloc.o);
    let q = iloc.o + 4;
    const b0 = dv.getUint8(q), b1 = dv.getUint8(q + 1);
    const offSize = b0 >> 4, lenSize = b0 & 15, baseSize = b1 >> 4;
    const idxSize = (ver === 1 || ver === 2) ? (b1 & 15) : 0;
    q += 2;
    let count;
    if (ver < 2) { count = dv.getUint16(q); q += 2; } else { count = dv.getUint32(q); q += 4; }
    const readN = (o, nb) => { let v = 0; for (let i = 0; i < nb; i++) v = v * 256 + dv.getUint8(o + i); return v; };
    for (let i = 0; i < count && q < iloc.end; i++) {
      let id;
      if (ver < 2) { id = dv.getUint16(q); q += 2; } else { id = dv.getUint32(q); q += 4; }
      let method = 0;
      if (ver === 1 || ver === 2) { method = dv.getUint16(q) & 15; q += 2; }
      q += 2; // data_reference_index
      const base = readN(q, baseSize); q += baseSize;
      const extents = dv.getUint16(q); q += 2;
      for (let e = 0; e < extents; e++) {
        if (idxSize) q += idxSize;
        const eOff = readN(q, offSize); q += offSize;
        const eLen = readN(q, lenSize); q += lenSize;
        if (id === exifId && e === 0) {
          if (method !== 0) return null;
          const abs = base + eOff;
          if (eLen < 8 || abs + eLen > len) return null;
          return exifPayloadToTiff(buf.slice(abs, abs + eLen));
        }
      }
    }
  }
  return null;
}

// HEIF Exif アイテム: u32 tiffヘッダオフセット + ("Exif\0\0")? + TIFF
function exifPayloadToTiff(payload) {
  const dv = new DataView(payload);
  const isTiff = o => {
    if (o < 0 || o + 8 > payload.byteLength) return false;
    const m = dv.getUint16(o);
    if (m !== 0x4949 && m !== 0x4D4D) return false;
    return dv.getUint16(o + 2, m === 0x4949) === 0x002A;
  };
  let start = 4 + dv.getUint32(0);
  if (!isTiff(start)) {
    start = -1;
    for (let i = 0; i < Math.min(payload.byteLength - 8, 64); i++) {
      if (isTiff(i)) { start = i; break; }
    }
    if (start < 0) return null;
  }
  return payload.slice(start);
}

function exifFromJpeg(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return null;
  let p = 2;
  while (p + 4 <= buf.byteLength) {
    const marker = dv.getUint16(p);
    if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA || marker === 0xFFD9) break;
    const segLen = dv.getUint16(p + 2);
    if (segLen < 2) break;
    if (marker === 0xFFE1 && segLen >= 10) {
      const u = new Uint8Array(buf, p + 4, 6);
      if (u[0] === 0x45 && u[1] === 0x78 && u[2] === 0x69 && u[3] === 0x66 && u[4] === 0 && u[5] === 0) {
        return buf.slice(p + 10, p + 2 + segLen);
      }
    }
    p += 2 + segLen;
  }
  return null;
}

function exifFromPng(buf) {
  const dv = new DataView(buf);
  const u = new Uint8Array(buf);
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (u.length < 8 || SIG.some((b, i) => u[i] !== b)) return null;
  let p = 8;
  while (p + 12 <= buf.byteLength) {
    const clen = dv.getUint32(p);
    const type = String.fromCharCode(u[p + 4], u[p + 5], u[p + 6], u[p + 7]);
    if (type === "eXIf") return buf.slice(p + 8, p + 8 + clen);
    if (type === "IEND") break;
    p += 12 + clen;
  }
  return null;
}

function exifFromWebp(buf) {
  const dv = new DataView(buf);
  const u = new Uint8Array(buf);
  const cc = o => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  if (u.length < 16 || cc(0) !== "RIFF" || cc(8) !== "WEBP") return null;
  let p = 12;
  while (p + 8 <= buf.byteLength) {
    const type = cc(p), size = dv.getUint32(p + 4, true);
    if (type === "EXIF") {
      let d = buf.slice(p + 8, Math.min(p + 8 + size, buf.byteLength));
      const du = new Uint8Array(d);
      if (du.length > 6 && du[0] === 0x45 && du[1] === 0x78 && du[2] === 0x69 && du[3] === 0x66 && du[4] === 0 && du[5] === 0) {
        d = d.slice(6);
      }
      return d;
    }
    p += 8 + size + (size & 1);
  }
  return null;
}

/* ---------- 各コンテナへの EXIF 埋め込み ---------- */

// JPEG: SOI 直後に APP1 "Exif\0\0" + TIFF を差し込む
function jpegWithExif(jpegBuf, tiff) {
  if (tiff.byteLength + 8 > 0xFFFF) return jpegBuf; // APP1 に収まらない場合は諦める
  const u = new Uint8Array(jpegBuf);
  if (u.length < 2 || u[0] !== 0xFF || u[1] !== 0xD8) return jpegBuf;
  const segLen = 2 + 6 + tiff.byteLength;
  const seg = new Uint8Array(4 + 6 + tiff.byteLength);
  seg[0] = 0xFF; seg[1] = 0xE1; seg[2] = segLen >> 8; seg[3] = segLen & 255;
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
  seg.set(new Uint8Array(tiff), 10);
  const out = new Uint8Array(u.length + seg.length);
  out.set(u.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(u.subarray(2), 2 + seg.length);
  return out.buffer;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// PNG: IHDR の直後に eXIf チャンクを差し込む
function pngWithExif(pngBuf, tiff) {
  const u = new Uint8Array(pngBuf);
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (u.length < 33 || SIG.some((b, i) => u[i] !== b)) return pngBuf;
  const insertAt = 33; // 8(署名) + 25(IHDRチャンク)
  const data = new Uint8Array(tiff);
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set([0x65, 0x58, 0x49, 0x66], 4); // "eXIf"
  chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const out = new Uint8Array(u.length + chunk.length);
  out.set(u.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(u.subarray(insertAt), insertAt + chunk.length);
  return out.buffer;
}

// WebP: VP8X の EXIF フラグを立てて末尾に EXIF チャンクを追加
// (シンプル形式なら VP8X チャンクを新設して拡張形式にする)
function webpWithExif(webpBuf, tiff, width, height) {
  const src = new Uint8Array(webpBuf);
  const cc = o => String.fromCharCode(src[o], src[o + 1], src[o + 2], src[o + 3]);
  if (src.length < 16 || cc(0) !== "RIFF" || cc(8) !== "WEBP") return webpBuf;

  const data = new Uint8Array(tiff);
  const exifChunk = new Uint8Array(8 + data.length + (data.length & 1));
  exifChunk.set([0x45, 0x58, 0x49, 0x46], 0); // "EXIF"
  new DataView(exifChunk.buffer).setUint32(4, data.length, true);
  exifChunk.set(data, 8);

  let body;
  if (cc(12) === "VP8X") {
    body = new Uint8Array(src.length - 12 + exifChunk.length);
    body.set(src.subarray(12), 0);
    body[8] |= 0x08; // EXIF フラグ
    body.set(exifChunk, src.length - 12);
  } else {
    const vp8x = new Uint8Array(18);
    vp8x.set([0x56, 0x50, 0x38, 0x58], 0); // "VP8X"
    new DataView(vp8x.buffer).setUint32(4, 10, true);
    vp8x[8] = 0x08; // EXIF フラグ
    const put24 = (o, v) => { vp8x[o] = v & 255; vp8x[o + 1] = (v >> 8) & 255; vp8x[o + 2] = (v >> 16) & 255; };
    put24(12, width - 1);
    put24(15, height - 1);
    body = new Uint8Array(vp8x.length + (src.length - 12) + exifChunk.length);
    body.set(vp8x, 0);
    body.set(src.subarray(12), vp8x.length);
    body.set(exifChunk, vp8x.length + src.length - 12);
  }
  const out = new Uint8Array(12 + body.length);
  out.set(src.subarray(0, 12), 0);
  out.set(body, 12);
  new DataView(out.buffer).setUint32(4, 4 + body.length, true); // RIFF サイズ更新
  return out.buffer;
}

/* ================================================================
   変換パイプライン
   ================================================================ */

function sniff(buf, name) {
  const u = new Uint8Array(buf);
  if (u.length >= 12) {
    if (u[0] === 0xFF && u[1] === 0xD8) return "jpeg";
    if (u[0] === 0x89 && u[1] === 0x50) return "png";
    if (u[0] === 0x52 && u[1] === 0x49 && u[8] === 0x57 && u[9] === 0x45) return "webp";
    if (u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) return "gif";
    if (u[0] === 0x42 && u[1] === 0x4D) return "bmp";
    if (String.fromCharCode(u[4], u[5], u[6], u[7]) === "ftyp") {
      const brand = String.fromCharCode(u[8], u[9], u[10], u[11]);
      return (brand === "avif" || brand === "avis") ? "avif" : "heic";
    }
  }
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "heic" || ext === "heif") return "heic";
  return "unknown";
}

let heicLibPromise = null;
function loadHeic2any() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  heicLibPromise = heicLibPromise || new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "./vendor/heic2any.min.js";
    s.onload = () => window.heic2any ? resolve(window.heic2any) : reject(new Error("HEICデコーダの初期化に失敗"));
    s.onerror = () => reject(new Error("HEICデコーダの読み込みに失敗"));
    document.head.appendChild(s);
  });
  return heicLibPromise;
}

let zipLibPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  zipLibPromise = zipLibPromise || new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "./vendor/jszip.min.js";
    s.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error("ZIPライブラリの初期化に失敗"));
    s.onerror = () => reject(new Error("ZIPライブラリの読み込みに失敗"));
    document.head.appendChild(s);
  });
  return zipLibPromise;
}

async function decodeToBitmap(buf, kind) {
  const blob = new Blob([buf]);
  const native = async () => {
    try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); }
    catch { return await createImageBitmap(blob); }
  };
  if (kind === "heic") {
    try { return await native(); } // Safari 等は HEIC をネイティブでデコードできる
    catch {
      const heic2any = await loadHeic2any();
      let out = await heic2any({ blob, toType: "image/png" });
      if (Array.isArray(out)) out = out[0];
      return await createImageBitmap(out);
    }
  }
  return await native();
}

async function canvasToBlob(canvas, mime, quality) {
  const blob = await new Promise(r => canvas.toBlob(r, mime, quality));
  if (!blob) throw new Error("この形式での書き出しに未対応のブラウザです");
  if (mime !== "image/png" && blob.type !== mime) {
    throw new Error(mime.replace("image/", "").toUpperCase() + " 書き出しに未対応のブラウザです");
  }
  return blob;
}

// file と変換オプションを受け取り、変換結果 blob とメタ情報を返す
async function convertOne(item, opts) {
  const buf = await item.file.arrayBuffer();
  const kind = sniff(buf, item.file.name);

  let tiff = null;
  try {
    if (kind === "heic" || kind === "avif") tiff = exifFromIsoBmff(buf);
    else if (kind === "jpeg") tiff = exifFromJpeg(buf);
    else if (kind === "png") tiff = exifFromPng(buf);
    else if (kind === "webp") tiff = exifFromWebp(buf);
  } catch { tiff = null; }

  const bmp = await decodeToBitmap(buf, kind);
  const scale = opts.maxEdge > 0 ? Math.min(1, opts.maxEdge / Math.max(bmp.width, bmp.height)) : 1;
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (opts.mime === "image/jpeg") { // JPG は透過を持てないので白で敷く
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();

  const outBlob = await canvasToBlob(canvas, opts.mime, opts.quality);
  let outBuf = await outBlob.arrayBuffer();

  let shotDate = null, exifKept = false, gpsRemoved = false;
  if (tiff) {
    shotDate = exifDate(tiff);
    if (opts.keepExif) {
      const t = tiff.slice(0);
      normalizeOrientation(t);
      let ok = true;
      if (opts.stripGps) {
        ok = stripGps(t);
        gpsRemoved = ok && exifHasGps(tiff);
      }
      if (ok) {
        if (opts.mime === "image/jpeg") outBuf = jpegWithExif(outBuf, t);
        else if (opts.mime === "image/png") outBuf = pngWithExif(outBuf, t);
        else if (opts.mime === "image/webp") outBuf = webpWithExif(outBuf, t, w, h);
        exifKept = true;
      }
    }
  }

  return {
    blob: new Blob([outBuf], { type: opts.mime }),
    kind, width: w, height: h, srcW: Math.round(w / scale), srcH: Math.round(h / scale),
    shotDate, exifKept, gpsRemoved,
    hadGps: tiff ? exifHasGps(tiff) : false,
  };
}
