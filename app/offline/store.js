// IndexedDB store for everything personal or offline. One database, prefixed per ARCHITECTURE 1.2.
// Stores: tiles (offline package tiles, key "<pkgId>|<source>/<z>/<x>/<y>"), packages (package metadata),
// saved (favorites, notes, imported routes). Nothing here is ever sent anywhere.

const DB_NAME = 'skintrack-data';
const DB_VERSION = 1;
let dbPromise = null;

/** Open (and upgrade) the database once per page. */
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
      if (!db.objectStoreNames.contains('packages')) db.createObjectStore('packages', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('saved')) db.createObjectStore('saved', {keyPath: 'id'});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
  return dbPromise;
}

/** Run one request against a store and resolve with its result. */
async function run(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export const get = (store, key) => run(store, 'readonly', s => s.get(key));
export const put = (store, value, key) => run(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const all = store => run(store, 'readonly', s => s.getAll());

/** Delete every key that starts with prefix (used to drop one package's tiles). */
export const delPrefix = (store, prefix) =>
  run(store, 'readwrite', s => s.delete(IDBKeyRange.bound(prefix, `${prefix}￿`)));

/** Count keys with a prefix and sum the byte length of their values (actual stored size). */
export async function measurePrefix(store, prefix) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let count = 0; let bytes = 0; let empty = 0;
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).openCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      count += 1;
      const v = c.value;
      if (v && v.byteLength) bytes += v.byteLength; else empty += 1;
      c.continue();
    };
    tx.oncomplete = () => resolve({count, bytes, empty});
    tx.onerror = () => reject(tx.error);
  });
}

/** True when the key exists (used to resume interrupted downloads). */
export const hasKey = (store, key) => run(store, 'readonly', s => s.getKey(key)).then(k => k !== undefined);
