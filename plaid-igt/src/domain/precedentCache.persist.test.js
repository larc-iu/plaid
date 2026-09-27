import { describe, it, expect, vi, beforeEach } from 'vitest';

// The browser's store, in memory: what a reload or a second tab finds.
const store = vi.hoisted(() => ({ records: new Map() }));
vi.mock('./precedentStore.js', () => ({
  loginHash: (token) => `h:${token}`,
  readStored: async (key, login) => {
    const rec = store.records.get(key);
    return rec && rec.login === login ? structuredClone(rec) : null;
  },
  writeStored: async (key, record) => {
    store.records.set(key, structuredClone(record));
  },
  clearStored: async () => store.records.clear(),
}));

const { dropPrecedent, leavePrecedent, openPrecedent, precedentBase } = await import(
  './precedentCache.js'
);
const { precedentCounts } = await import('./precedent.js');

const layerInfo = {
  primaryTokenLayer: { id: 'wordL' },
  morphemeTokenLayer: null,
  spanLayers: { word: [{ id: 'glossL', name: 'Gloss' }], morpheme: [], sentence: [] },
};

// One server, shared by every tab: a Gloss per document, and versions.
function server(glossByDoc) {
  return { glossByDoc, versions: {} };
}

// A tab: its own client for the same login.
function tab(srv, token = 'alice') {
  const client = {
    baseUrl: 'http://core',
    token,
    documentVersions: {},
    projects: {
      listDocuments: vi.fn(async () =>
        Object.keys(srv.glossByDoc).map((id) => ({ id, version: srv.versions[id] ?? 1 })),
      ),
    },
    query: vi.fn(async (q) => {
      const doc = q.where[0][2].doc;
      const counts = new Map();
      for (const [d, rows] of Object.entries(srv.glossByDoc)) {
        if (doc && d !== doc) continue;
        for (const [form, value] of rows) {
          const k = `${form}\u0000${value}`;
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
      return { results: [...counts].map(([k, n]) => [...k.split('\u0000'), null, null, n]) };
    }),
  };
  return client;
}

const docOf = (client, id, glosses = []) => ({
  id,
  raw: { id, version: 1 },
  projectId: 'p1',
  client,
  layerInfo,
  vocabularies: {},
  dataVersion: 0,
  sentences: [
    {
      tokens: glosses.map(([form, value]) => ({
        content: form,
        annotations: { Gloss: { value, metadata: {} } },
        morphemes: [],
      })),
    },
  ],
});

const gloss = (tally) => precedentCounts(tally, 'word', 'kai', 'Gloss');
const projectQueries = (client) => client.query.mock.calls.filter(([q]) => !q.where[0][2].doc);

// A reload: the tab's memory is gone, the browser's store is not.
function reload() {
  const kept = new Map(store.records);
  dropPrecedent();
  store.records = kept;
}

describe('precedent kept across reloads', () => {
  beforeEach(() => {
    dropPrecedent();
    store.records = new Map();
  });

  it('a reload starts from the kept count when nothing changed', async () => {
    const srv = server({ a: [['kai', 'go']], b: [['kai', 'go']] });
    const first = tab(srv);
    await openPrecedent(docOf(first, 'a'));
    expect(projectQueries(first)).toHaveLength(1);
    reload();
    const second = tab(srv);
    const b = docOf(second, 'b');
    await openPrecedent(b);
    expect(projectQueries(second)).toHaveLength(0);
    expect(gloss(precedentBase(b))).toEqual(new Map([['go', 1]]));
  });

  it('a reload counts again when anything was saved elsewhere meanwhile', async () => {
    const srv = server({ a: [['kai', 'go']], b: [] });
    await openPrecedent(docOf(tab(srv), 'a'));
    reload();
    srv.glossByDoc.a = [['kai', 'eat']];
    srv.versions.a = 2;
    const second = tab(srv);
    const b = docOf(second, 'b');
    await openPrecedent(b);
    expect(projectQueries(second)).toHaveLength(1);
    expect(gloss(precedentBase(b))).toEqual(new Map([['eat', 1]]));
  });

  it('a document edited and left before the reload still counts as it was left', async () => {
    const srv = server({ a: [['kai', 'go']], b: [] });
    const first = tab(srv);
    const a = docOf(first, 'a', [['kai', 'go']]);
    await openPrecedent(a);
    a.sentences = docOf(first, 'a', [['kai', 'eat']]).sentences;
    a.dataVersion++;
    srv.glossByDoc.a = [['kai', 'eat']];
    srv.versions.a = 2;
    first.documentVersions = { a: 2 };
    leavePrecedent(a, { wordFields: ['Gloss'] });
    await Promise.resolve();
    reload();
    const second = tab(srv);
    const b = docOf(second, 'b');
    await openPrecedent(b);
    expect(projectQueries(second)).toHaveLength(0);
    expect(gloss(precedentBase(b))).toEqual(new Map([['eat', 1]]));
  });

  it('the document opened after a reload is held to the kept count', async () => {
    const srv = server({ a: [['kai', 'go']], b: [['kai', 'go']] });
    await openPrecedent(docOf(tab(srv), 'a'));
    reload();
    // This person saved b before the reload, from a tab that never left it,
    // so the kept count holds b's old rows.
    srv.glossByDoc.b = [['kai', 'eat']];
    srv.versions.b = 2;
    const second = tab(srv);
    second.documentVersions = { b: 2 };
    const b = docOf(second, 'b', [['kai', 'eat']]);
    b.raw.version = 2;
    await openPrecedent(b);
    // Read again, since the kept rows for b are not the ones subtracted.
    await openPrecedent(b);
    expect(projectQueries(second)).toHaveLength(1);
    expect(gloss(precedentBase(b))).toEqual(new Map([['go', 1]]));
  });

  it('another login never gets the kept count', async () => {
    const srv = server({ a: [['kai', 'go']], b: [] });
    await openPrecedent(docOf(tab(srv, 'alice'), 'a'));
    reload();
    const bob = tab(srv, 'bob');
    await openPrecedent(docOf(bob, 'b'));
    expect(projectQueries(bob)).toHaveLength(1);
  });
});
