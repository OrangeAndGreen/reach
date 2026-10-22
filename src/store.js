// store.js - what Reach keeps between visits in IndexedDB: elevation tiles
// and OpenStreetMap cells. Where the browser won't open a database (a private
// window, blocked site data) every call quietly finds nothing and saves nothing.

const NAME = 'reach';

let opened = null;
function db() {
  if (!opened) {
    opened = new Promise((resolve) => {
      try {
        const req = indexedDB.open(NAME, 1);
        req.onupgradeneeded = () => {
          // a tile is { blob, savedAt }, so the oldest can go first; an OSM cell is { elements, readAt }
          req.result.createObjectStore('tiles').createIndex('savedAt', 'savedAt');
          req.result.createObjectStore('osm');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return opened;
}

/** One request in its own transaction, as a promise of its result; fallback where there's no database or it fails. */
async function run(store, mode, make, fallback) {
  const d = await db();
  if (!d) return fallback;
  return new Promise((resolve) => {
    try {
      const req = make(d.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(fallback);
    } catch { resolve(fallback); }
  });
}

/** The values saved under keys, in their order, undefined where none is. */
export async function getMany(store, keys) {
  const d = await db();
  if (!d || !keys.length) return keys.map(() => undefined);
  return new Promise((resolve) => {
    const out = new Array(keys.length);
    try {
      const tx = d.transaction(store, 'readonly'), os = tx.objectStore(store);
      keys.forEach((k, i) => { os.get(k).onsuccess = (e) => { out[i] = e.target.result; }; });
      tx.oncomplete = () => resolve(out);
      tx.onerror = tx.onabort = () => resolve(keys.map(() => undefined));
    } catch { resolve(keys.map(() => undefined)); }
  });
}

export const get = (store, key) => run(store, 'readonly', (os) => os.get(key), undefined);

/** Saves each [key, value] in one transaction. Resolves false if it couldn't (the disk full, say). */
export async function putMany(store, entries) {
  const d = await db();
  if (!d || !entries.length) return false;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(store, 'readwrite'), os = tx.objectStore(store);
      for (const [k, v] of entries) os.put(v, k);
      tx.oncomplete = () => resolve(true);
      tx.onerror = tx.onabort = () => resolve(false);
    } catch { resolve(false); }
  });
}

export const count = (store) => run(store, 'readonly', (os) => os.count(), 0);
export const clear = (store) => run(store, 'readwrite', (os) => os.clear(), undefined);

/** Deletes the n entries with the smallest value of an index (the oldest, for a time). */
export async function dropOldest(store, index, n) {
  const d = await db();
  if (!d || n <= 0) return;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(store, 'readwrite'), os = tx.objectStore(store);
      let left = n;
      os.index(index).openKeyCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (!c || left-- <= 0) return;
        os.delete(c.primaryKey);
        c.continue();
      };
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    } catch { resolve(); }
  });
}
