import { describe, it, expect, beforeAll } from 'vitest';

// Just enough of IndexedDB for the store: one database, one object store,
// requests that answer on a later tick and a transaction that completes after.
function fakeIndexedDb() {
  const data = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const request = (compute) => {
    const req = {};
    later(() => {
      req.result = compute();
      req.onsuccess?.();
    });
    return req;
  };
  const db = {
    transaction: () => {
      const tx = {};
      const store = {
        get: (key) => request(() => structuredClone(data.get(key))),
        put: (value, key) => request(() => data.set(key, structuredClone(value)) && key),
        clear: () => request(() => data.clear()),
      };
      tx.objectStore = () => store;
      later(() => later(() => tx.oncomplete?.()));
      return tx;
    },
    createObjectStore: () => {},
  };
  return {
    data,
    open: () => {
      const req = { result: db };
      later(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

let idb;
let store;
beforeAll(async () => {
  idb = fakeIndexedDb();
  globalThis.indexedDB = idb;
  store = await import('./precedentStore.js');
});

describe('precedentStore', () => {
  it('hands a record back only to the login that kept it', async () => {
    await store.writeStored('k', { login: 'a', results: 1 });
    expect(await store.readStored('k', 'a')).toEqual({ login: 'a', results: 1 });
    expect(await store.readStored('k', 'b')).toBe(null);
  });

  it('signing out forgets every record and keeps nothing written after', async () => {
    await store.writeStored('k', { login: 'a', results: 1 });
    await store.closeStore();
    expect(idb.data.size).toBe(0);
    // A read that lands between the sign-out and the reload.
    await store.writeStored('k', { login: 'a', results: 2 });
    expect(idb.data.size).toBe(0);
    expect(await store.readStored('k', 'a')).toBe(null);
  });
});
