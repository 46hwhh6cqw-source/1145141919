"use strict";

// オフライン動作用サービスワーカー。デプロイ時は CACHE のバージョンを上げる。
const CACHE = "imgconv-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./converter.js",
  "./app.js",
  "./manifest.webmanifest",
  "./vendor/heic2any.min.js",
  "./vendor/jszip.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) return;
  // ?ui=compact 等のクエリ付き起動でもキャッシュ済みのページ本体を返す
  const ignoreSearch = e.request.mode === "navigate";
  e.respondWith(
    caches.match(e.request, { ignoreSearch }).then(hit =>
      hit ||
      fetch(e.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
    )
  );
});
