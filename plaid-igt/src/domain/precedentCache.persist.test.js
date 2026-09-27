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
  closeStore: async () => {
    store.closed = true;
    store.records.clear();
  },
}));

const { dropPrecedent, forgetPrecedent, leavePrecedent, openPrecedent, precedentBase } =
  await import('./precedentCache.js');
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

  // The most common reload: inside the document just edited. The editor is
  // not unmounted on unload, so nothing was left behind for it.
  it('a reload inside a document edited there counts nothing, and ranks as before', async () => {
    const srv = server({ a: [['kai', 'go']], b: [['kai', 'go']] });
    const first = tab(srv);
    const a = docOf(first, 'a', [['kai', 'go']]);
    await openPrecedent(a);
    a.sentences = docOf(first, 'a', [['kai', 'eat']]).sentences;
    a.dataVersion++;
    srv.glossByDoc.a = [['kai', 'eat']];
    srv.versions.a = 2;
    first.documentVersions = { a: 2 };
    reload();
    const second = tab(srv);
    second.documentVersions = { a: 2 };
    const again = docOf(second, 'a', [['kai', 'eat']]);
    again.raw.version = 2;
    await openPrecedent(again);
    await openPrecedent(again);
    expect(projectQueries(second)).toHaveLength(0);
    // b's go, with a's old go taken out: a counts live.
    expect(gloss(precedentBase(again))).toEqual(new Map([['go', 1]]));
  });

  it('a document edited before the reload and left after it counts as it was left', async () => {
    const srv = server({ a: [['kai', 'go']], b: [['kai', 'go']] });
    const first = tab(srv);
    const a = docOf(first, 'a', [['kai', 'go']]);
    await openPrecedent(a);
    a.sentences = docOf(first, 'a', [['kai', 'eat']]).sentences;
    a.dataVersion++;
    srv.glossByDoc.a = [['kai', 'eat']];
    srv.versions.a = 2;
    reload();
    const second = tab(srv);
    second.documentVersions = { a: 2 };
    const again = docOf(second, 'a', [['kai', 'eat']]);
    again.raw.version = 2;
    await openPrecedent(again);
    // Left with no further edit: it still differs from the rows the count holds.
    leavePrecedent(again, { wordFields: ['Gloss'] });
    const b = docOf(second, 'b');
    await openPrecedent(b);
    await openPrecedent(b);
    expect(projectQueries(second)).toHaveLength(0);
    expect(gloss(precedentBase(b))).toEqual(new Map([['eat', 1]]));
  });

  it('a new tab opening a document still open and edited in another counts nothing', async () => {
    const srv = server({ a: [['kai', 'go']], b: [['kai', 'go']] });
    const first = tab(srv);
    const b = docOf(first, 'b');
    await openPrecedent(b);
    leavePrecedent(b, { wordFields: ['Gloss'] });
    const a = docOf(first, 'a', [['kai', 'go']]);
    await openPrecedent(a);
    a.sentences = docOf(first, 'a', [['kai', 'eat']]).sentences;
    a.dataVersion++;
    srv.glossByDoc.a = [['kai', 'eat']];
    srv.versions.a = 2;
    first.documentVersions = { a: 2 };
    reload();
    const second = tab(srv);
    const inNew = docOf(second, 'a', [['kai', 'eat']]);
    inNew.raw.version = 2;
    await openPrecedent(inNew);
    await openPrecedent(inNew);
    expect(projectQueries(second)).toHaveLength(0);
    expect(gloss(precedentBase(inNew))).toEqual(new Map([['go', 1]]));
  });

  it('kept rows of a document saved elsewhere since are not used for it', async () => {
    const srv = server({ a: [['kai', 'go']], b: [['kai', 'go']] });
    const first = tab(srv);
    const a = docOf(first, 'a', [['kai', 'go']]);
    await openPrecedent(a);
    reload();
    // Someone else saves a and b after the count was kept.
    srv.glossByDoc.a = [['kai', 'eat']];
    srv.glossByDoc.b = [['kai', 'eat']];
    srv.versions.a = 2;
    srv.versions.b = 2;
    const second = tab(srv);
    const again = docOf(second, 'a', [['kai', 'eat']]);
    again.raw.version = 2;
    await openPrecedent(again);
    await openPrecedent(again);
    expect(projectQueries(second)).toHaveLength(1);
    expect(gloss(precedentBase(again))).toEqual(new Map([['eat', 1]]));
  });

  // The document's own rows were read before this tab's edit landed, and the
  // project after it: the rows taken out are not the ones the count holds.
  it('an edit landing while the project is counted is put right at the next check', async () => {
    const srv = server({ a: [['kai', 'go']], b: [['kai', 'go']] });
    const first = tab(srv);
    const a = docOf(first, 'a', [['kai', 'go']]);
    const opening = openPrecedent(a);
    a.sentences = docOf(first, 'a', [['kai', 'eat']]).sentences;
    a.dataVersion++;
    srv.glossByDoc.a = [['kai', 'eat']];
    srv.versions.a = 2;
    first.documentVersions = { a: 2 };
    await opening;
    await openPrecedent(a, { check: true });
    await openPrecedent(a);
    expect(gloss(precedentBase(a))).toEqual(new Map([['go', 1]]));
    // Left, it stands in for its rows only over rows the count holds.
    leavePrecedent(a, { wordFields: ['Gloss'] });
    const b = docOf(first, 'b');
    await openPrecedent(b);
    await openPrecedent(b);
    expect(gloss(precedentBase(b))).toEqual(new Map([['eat', 1]]));
  });

  // Someone saved the document between the editor reading it and its rows
  // being read: the rows are newer than the version they were taken for.
  it('rows read across a save made elsewhere are never kept for a reload', async () => {
    const srv = server({ a: [['kai', 'go']], b: [['kai', 'go']] });
    const first = tab(srv);
    const b = docOf(first, 'b');
    await openPrecedent(b);
    await openPrecedent(b);
    leavePrecedent(b, { wordFields: ['Gloss'] });
    const a = docOf(first, 'a', [['kai', 'go']]);
    srv.glossByDoc.a = [['kai', 'eat']];
    srv.versions.a = 2;
    await openPrecedent(a);
    await openPrecedent(a);
    reload();
    const second = tab(srv);
    const again = docOf(second, 'a', [['kai', 'eat']]);
    again.raw.version = 2;
    await openPrecedent(again);
    await openPrecedent(again, { check: true });
    await openPrecedent(again);
    expect(gloss(precedentBase(again))).toEqual(new Map([['go', 1]]));
  });

  it('another tab signing out empties the browser store and keeps this tab counting', async () => {
    const srv = server({ a: [['kai', 'go']], b: [['kai', 'go']] });
    const first = tab(srv);
    const a = docOf(first, 'a');
    await openPrecedent(a);
    await openPrecedent(a);
    await forgetPrecedent({ elsewhere: true });
    expect(store.records.size).toBe(0);
    expect(store.closed).toBe(true);
    expect(gloss(precedentBase(a))).toEqual(new Map([['go', 1]]));
    store.closed = false;
  });

  it('signing out forgets the counts in memory and in the browser', async () => {
    const srv = server({ a: [['kai', 'go']], b: [] });
    const first = tab(srv);
    await openPrecedent(docOf(first, 'a'));
    expect(store.records.size).toBeGreaterThan(0);
    await forgetPrecedent();
    expect(store.records.size).toBe(0);
    expect(store.closed).toBe(true);
    const b = docOf(first, 'b');
    expect(precedentBase(b)).toBe(null);
    // Nothing more is read in the moment before the page leaves.
    expect(openPrecedent(b)).toBe(null);
    expect(projectQueries(first)).toHaveLength(1);
    store.closed = false;
  });
});
