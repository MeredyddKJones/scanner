/* IndexedDB layer. No window/document references — sw.js importScripts this
   too, so the share-target handler can stash incoming files. */
"use strict";

const DB = (() => {
  const NAME = "scanner-db";
  const VERSION = 1;
  let dbp = null;

  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
          if (!db.objectStoreNames.contains("incoming")) db.createObjectStore("incoming", { autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }

  function p(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function store(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  return {
    // documents: {id, name, created, updated, pages:[{originalBlob, processedBlob, corners, filter, rotation, thumbUrl, width, height}]}
    putDoc: async (doc) => p((await store("docs", "readwrite")).put(doc)),
    getDoc: async (id) => p((await store("docs", "readonly")).get(id)),
    allDocs: async () => p((await store("docs", "readonly")).getAll()),
    delDoc: async (id) => p((await store("docs", "readwrite")).delete(id)),

    kvSet: async (key, value) => p((await store("kv", "readwrite")).put(value, key)),
    kvGet: async (key) => p((await store("kv", "readonly")).get(key)),
    kvDel: async (key) => p((await store("kv", "readwrite")).delete(key)),

    // files shared into the app via the Android share sheet
    pushIncoming: async (files) => p((await store("incoming", "readwrite")).add(files)),
    takeIncoming: async () => {
      const s = await store("incoming", "readwrite");
      const all = await p(s.getAll());
      await p(s.clear());
      return all.flat();
    },
  };
})();
