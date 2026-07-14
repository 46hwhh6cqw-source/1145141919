// ポータブル版（単一HTMLファイル）ビルドスクリプト
// index.html に vendor ライブラリと converter.js / app.js を焼き込み、
// file:// でダブルクリック起動できる1ファイルを生成する。
//
//   node image-converter/build-portable.mjs
//
// 出力: image-converter/portable/image-converter-portable.html

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(dir, f), "utf8");

// インライン<script>内で "</script>" がタグ終端と誤認されないようエスケープ
const inline = js => js.replace(/<\/script/gi, "<\\/script");

let html = read("index.html");
const heic2any = read("vendor/heic2any.min.js");
const jszip = read("vendor/jszip.min.js");
const converter = read("converter.js");
const app = read("app.js");
const favicon = fs.readFileSync(path.join(dir, "icons/icon-192.png")).toString("base64");

// PWA用のリンク類と、ポータブル版では意味を持たない要素
// （サイトへの戻りリンク・ポータブル版DL・インストール手順）を除去し、
// faviconはデータURIで埋め込む
html = html
  .replace(/\s*<link rel="manifest"[^>]*\/>/, "")
  .replace(/\s*<link rel="icon"[^>]*\/>/, `\n  <link rel="icon" type="image/png" href="data:image/png;base64,${favicon}" />`)
  .replace(/\s*<link rel="apple-touch-icon"[^>]*\/>/, "")
  .replace(/<title>[^<]*<\/title>/, "<title>画像かんたん変換（ポータブル版）</title>")
  .replace(/\s*<a class="back"[^>]*>[\s\S]*?<\/a>/, "")
  .replace(/\s*<span id="portableNote">[\s\S]*?<\/span>/, "")
  .replace(/\s*<details id="installHelp">[\s\S]*?<\/details>/, "");

// スクリプトをすべてインライン化（vendor は先に読み込ませ、遅延ロードを不要にする）
const scripts =
  `<script>window.__PORTABLE__ = true;</script>\n` +
  `<script>${inline(heic2any)}</script>\n` +
  `<script>${inline(jszip)}</script>\n` +
  `<script>${inline(converter)}</script>\n` +
  `<script>${inline(app)}</script>`;
const replaced = html.replace(
  /<script src="\.\/converter\.js"><\/script>\s*<script src="\.\/app\.js"><\/script>/,
  () => scripts
);
if (replaced === html) {
  console.error("script tags not found in index.html — build aborted");
  process.exit(1);
}
html = replaced;

const outDir = path.join(dir, "portable");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "image-converter-portable.html");
fs.writeFileSync(out, html);
console.log("wrote " + out + " (" + (fs.statSync(out).size / 1048576).toFixed(2) + " MB)");
