/* Offline-first service worker. Bump VERSION whenever any file changes. */
const VERSION = "v1";
const CACHE = "scanner-" + VERSION;

const ASSETS = [
  "./",
  "index.html",
  "manifest.json",
  "css/style.css",
  "js/app.js",
  "js/detector.js",
  "js/exporter.js",
  "vendor/jspdf.umd.min.js",
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
    self.skipWaiting();
  })());
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
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
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
