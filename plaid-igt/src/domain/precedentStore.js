// The project precedent a tab counted (precedentCache.js), kept in the
// browser's IndexedDB so a reload or a second tab starts from it instead of
// counting the whole project again. What is kept is only ever used after
// asking the server whether anything changed since it was counted.
//
// Two records per server and cache key (the counts, and the documents beside
// them: precedentCache.js). Each record names the login that counted it by a
// hash of its token, and a record counted under another login is never handed
// back: the rows are what that login may read. Everything here is quiet on
// failure (a private window, blocked site data, a browser without IndexedDB):
// the tab counts as if nothing had been kept.

const DB_NAME = 'plaid-igt-precedent';
const STORE = 'projects';
// Raised whenever what is kept stops being what the app would count, and the
// store is then emptied on the first open. 2: the counts cover the open
// project only, where 1 counted the links of every project sharing its
// vocabulary.
const DB_VERSION = 2;

let dbPromise = null;

// Set on sign-out: nothing more is written until the page loads again, so a
// read landing between the sign-out and the reload keeps nothing.
let closed = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      // A tab loaded after the next bump needs this one to let go, or its
      // upgrade waits until every older tab is closed.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req?.result ?? null);
          tx.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

// FNV-1a over the token: enough to tell two logins apart without keeping the
// token itself in a second place.
export function loginHash(token) {
  let h = 0x811c9dc5;
  const s = String(token ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** The record kept under `key` for `login`, or null. */
export async function readStored(key, login) {
  const rec = await run('readonly', (store) => store.get(key));
  return rec && rec.login === login ? rec : null;
}

/** Keep `record` under `key`, replacing what was there. */
export function writeStored(key, record) {
  if (closed) return Promise.resolve(null);
  return run('readwrite', (store) => store.put(record, key));
}

/** Forget every record. */
export function clearStored() {
  return run('readwrite', (store) => store.clear());
}

/** Forget every record and keep nothing more (signing out). */
export function closeStore() {
  closed = true;
  return clearStored();
}
