import { describe, it, expect, beforeAll, vi } from 'vitest';

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
    objectStoreNames: { contains: () => false },
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

// A database an earlier version of the store left behind, with a record in it.
function fakeOldIndexedDb(version, records) {
  const stores = new Map([['projects', new Map(records)]]);
  let current = version;
  const later = (fn) => setTimeout(fn, 0);
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name) => stores.set(name, new Map()),
    deleteObjectStore: (name) => stores.delete(name),
    transaction: (name) => {
      const data = stores.get(name);
      const tx = {};
      const request = (compute) => {
        const req = {};
        later(() => {
          req.result = compute();
          req.onsuccess?.();
        });
        return req;
      };
      tx.objectStore = () => ({
        get: (key) => request(() => structuredClone(data.get(key))),
        put: (value, key) => request(() => data.set(key, structuredClone(value)) && key),
        clear: () => request(() => data.clear()),
      });
      later(() => later(() => tx.oncomplete?.()));
      return tx;
    },
  };
  return {
    stores,
    open: (name, v) => {
      const req = { result: db };
      later(() => {
        if (v > current) {
          current = v;
          req.onupgradeneeded?.({ oldVersion: version, newVersion: v });
        }
        req.onsuccess?.();
      });
      return req;
    },
  };
}

describe('precedentStore after an upgrade', () => {
  it('hands back nothing an earlier version kept: those counts took in other projects', async () => {
    const old = fakeOldIndexedDb(1, [['k', { login: 'a', results: 'every project' }]]);
    globalThis.indexedDB = old;
    vi.resetModules();
    const fresh = await import('./precedentStore.js');
    expect(await fresh.readStored('k', 'a')).toBe(null);
    expect(old.stores.get('projects').size).toBe(0);
    // And the store still works.
    await fresh.writeStored('k', { login: 'a', results: 1 });
    expect(await fresh.readStored('k', 'a')).toEqual({ login: 'a', results: 1 });
  });
});
