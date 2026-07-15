/* Offline-first service worker. Bump VERSION whenever any file changes. */
importScripts("js/db.js");

const VERSION = "v5";
const CACHE = "scanner-" + VERSION;
const TESSDATA_HOST = "tessdata.projectnaptha.com";

const ASSETS = [
  "./",
  "index.html",
  "manifest.json",
  "css/style.css",
  "js/app.js",
  "js/db.js",
  "js/detector.js",
  "js/exporter.js",
  "vendor/jspdf.umd.min.js",
  "vendor/fflate.js",
  "vendor/opencv.js",
  "vendor/tesseract.min.js",
  "vendor/worker.min.js",
  "vendor/tesseract-core-simd.wasm.js",
  "vendor/tesseract-core-simd.wasm",
  "vendor/eng.traineddata.gz",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // add individually so one flaky big download doesn't abort install
    await Promise.allSettled(ASSETS.map((a) => cache.add(a)));
    // no skipWaiting here: the page shows an update banner and asks for it
  })());
});

self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Android share sheet target: stash the files, bounce to the app
  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const files = fd.getAll("media").filter((f) => f && f.size);
        if (files.length) await DB.pushIncoming(files);
      } catch { /* fall through to the app regardless */ }
      return Response.redirect("./?shared=1", 303);
    })());
    return;
  }

  if (e.request.method !== "GET") return;

  // extra OCR language packs from the tessdata CDN: cache on first download
  const cacheable = url.origin === location.origin || url.hostname === TESSDATA_HOST;
  if (!cacheable) return;

  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    if (cached) return cached;
    const resp = await fetch(e.request);
    if (resp.ok) {
      const cache = await caches.open(CACHE);
      cache.put(e.request, resp.clone());
    }
    return resp;
  })());
});
