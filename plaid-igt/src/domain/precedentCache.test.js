import { describe, it, expect, vi } from 'vitest';
import { createTally, foldDocument, mergeTally, precedentCounts } from './precedent.js';
import { leavePrecedent, openPrecedent, precedentBase } from './precedentCache.js';

const layerInfo = {
  primaryTokenLayer: { id: 'wordL' },
  morphemeTokenLayer: null,
  spanLayers: { word: [{ id: 'glossL', name: 'Gloss' }], morpheme: [], sentence: [] },
};

// A server holding one Gloss per document: rows are [form, value, prov,
// provConfirmed, count], grouped over the documents a query covers.
// Each document's server version is 1 unless `versions` says otherwise.
let logins = 0;
function fakeClient(glossByDoc, versions = {}) {
  const client = {
    baseUrl: 'http://core',
    token: `t${++logins}`,
    projects: {
      listDocuments: vi.fn(async () =>
        Object.keys(glossByDoc).map((id) => ({ id, version: versions[id] ?? 1 })),
      ),
    },
    query: vi.fn(async (q) => {
      const doc = q.where[0][2].doc;
      const counts = new Map();
      for (const [d, rows] of Object.entries(glossByDoc)) {
        if (doc && d !== doc) continue;
        for (const [form, value] of rows) {
          const k = `${form}\u0000${value}`;
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
      return {
        results: [...counts].map(([k, n]) => [...k.split('\u0000'), null, null, n]),
      };
    }),
  };
  return client;
}

const docOf = (client, id, glosses = [], version = 1) => ({
  id,
  raw: { id, version },
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

// What the person does in the editor: the document's sentences change and
// its dataVersion bumps, on the same object.
function editGlosses(doc, glosses) {
  doc.sentences = docOf(doc.client, doc.id, glosses).sentences;
  doc.dataVersion++;
}

// What the editor ranks on: the base plus the document folded live.
function editorTally(doc) {
  const base = precedentBase(doc);
  const tally = base ? mergeTally(createTally(), base) : createTally();
  return foldDocument(tally, doc.sentences, { wordFields: ['Gloss'] });
}

const gloss = (tally) => precedentCounts(tally, 'word', 'kai', 'Gloss');
const projectQueries = (client) => client.query.mock.calls.filter(([q]) => !q.where[0][2].doc);

describe('precedentCache', () => {
  it('reads the project once, and each document only its own rows after that', async () => {
    const client = fakeClient({ a: [['kai', 'go']], b: [['kai', 'eat']], c: [['kai', 'go']] });
    const a = docOf(client, 'a');
    await openPrecedent(a);
    // Everything but a: b's eat and c's go.
    expect(gloss(precedentBase(a))).toEqual(
      new Map([
        ['eat', 1],
        ['go', 1],
      ]),
    );
    const b = docOf(client, 'b');
    await openPrecedent(b);
    expect(gloss(precedentBase(b))).toEqual(new Map([['go', 2]]));
    expect(projectQueries(client)).toHaveLength(1);
    // Back to a, through a new client for the same login: only whether
    // anything changed is asked, and nothing had.
    const calls = client.query.mock.calls.length;
    const lists = client.projects.listDocuments.mock.calls.length;
    const again = { ...client };
    await openPrecedent(docOf(again, 'a'));
    expect(client.query.mock.calls.length).toBe(calls);
    expect(client.projects.listDocuments.mock.calls.length).toBe(lists + 1);
    // Asked again on every render, the model already open asks nothing.
    expect(openPrecedent(docOf(again, 'a'))).not.toBeNull();
  });

  it('a document edited and left counts as it was left in the next one', async () => {
    const client = fakeClient({ a: [['kai', 'go']], b: [] });
    const a = docOf(client, 'a', [['kai', 'go']]);
    await openPrecedent(a);
    // The person changes a's kai from go to eat, then leaves.
    editGlosses(a, [['kai', 'eat']]);
    leavePrecedent(a, { wordFields: ['Gloss'] });
    const b = docOf(client, 'b');
    await openPrecedent(b);
    expect(gloss(precedentBase(b))).toEqual(new Map([['eat', 1]]));
  });

  it('a document left unchanged keeps its project rows', async () => {
    const client = fakeClient({ a: [['kai', 'go']], b: [] });
    const a = docOf(client, 'a');
    await openPrecedent(a);
    // Its local fold would say nothing (no sentences here), so an overlay
    // taken for an untouched document would lose its go.
    leavePrecedent(a, { wordFields: ['Gloss'] });
    const b = docOf(client, 'b');
    await openPrecedent(b);
    expect(gloss(precedentBase(b))).toEqual(new Map([['go', 1]]));
  });

  it('an edit still on its way when the project is read again counts once the document is left', async () => {
    const glossByDoc = { a: [['kai', 'go']], b: [] };
    const versions = {};
    const client = fakeClient(glossByDoc, versions);
    const a = docOf(client, 'a', [['kai', 'go']]);
    await openPrecedent(a);
    // The person reglosses kai as eat, and a read of the project (someone
    // saved b) runs while that write is still queued, so the server's rows
    // still say go.
    editGlosses(a, [['kai', 'eat']]);
    a.isSaving = true;
    versions.b = 2;
    await openPrecedent(a, { check: true });
    expect(projectQueries(client)).toHaveLength(2);
    a.isSaving = false;
    glossByDoc.a = [['kai', 'eat']]; // the write lands
    versions.a = 3;
    client.documentVersions = { a: 3 };
    leavePrecedent(a, { wordFields: ['Gloss'] });
    const b = docOf(client, 'b');
    await openPrecedent(b);
    expect(gloss(precedentBase(b))).toEqual(new Map([['eat', 1]]));
  });

  // The project is counted again only after a change, never on a timer.
  describe('only after a change', () => {
    it('asks whether anything changed, and counts nothing, however long it has been', async () => {
      const client = fakeClient({ a: [['kai', 'go']], b: [], c: [] });
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      await openPrecedent(docOf(client, 'a'));
      now.mockReturnValue(1_000_000 + 24 * 3600_000);
      const b = docOf(client, 'b');
      await openPrecedent(b);
      await openPrecedent(b, { check: true });
      await openPrecedent(docOf(client, 'c'));
      now.mockRestore();
      expect(projectQueries(client)).toHaveLength(1);
      expect(client.projects.listDocuments.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(gloss(precedentBase(b))).toEqual(new Map([['go', 1]]));
    });

    it('counts again when someone else saved a document, and drops what the old count kept', async () => {
      const glossByDoc = { a: [['kai', 'go']], b: [['kai', 'go']], c: [] };
      const versions = {};
      const client = fakeClient(glossByDoc, versions);
      const a = docOf(client, 'a', [['kai', 'go']]);
      await openPrecedent(a);
      editGlosses(a, [['kai', 'eat']]);
      leavePrecedent(a, { wordFields: ['Gloss'] });
      // Another person, or this person in another tab, reglosses b, and the
      // edit to a lands too.
      glossByDoc.b = [['kai', 'sleep']];
      versions.b = 2;
      glossByDoc.a = [['kai', 'eat']];
      versions.a = 2;
      client.documentVersions = { a: 2 };
      const c = docOf(client, 'c');
      await openPrecedent(c);
      expect(projectQueries(client)).toHaveLength(2);
      expect(gloss(precedentBase(c))).toEqual(
        new Map([
          ['eat', 1],
          ['sleep', 1],
        ]),
      );
    });

    it("never counts again for this tab's own saves", async () => {
      const glossByDoc = { a: [['kai', 'go']], b: [] };
      const versions = {};
      const client = fakeClient(glossByDoc, versions);
      const a = docOf(client, 'a', [['kai', 'go']]);
      await openPrecedent(a);
      // Saved while open: the tab's own write, and the check on coming back
      // to the tab.
      editGlosses(a, [['kai', 'eat']]);
      glossByDoc.a = [['kai', 'eat']];
      versions.a = 2;
      client.documentVersions = { a: 2 };
      await openPrecedent(a, { check: true });
      leavePrecedent(a, { wordFields: ['Gloss'] });
      const b = docOf(client, 'b');
      await openPrecedent(b);
      await openPrecedent(b, { check: true });
      expect(projectQueries(client)).toHaveLength(1);
      expect(gloss(precedentBase(b))).toEqual(new Map([['eat', 1]]));
    });

    it('counts a save made elsewhere to the document open here once it is left', async () => {
      const glossByDoc = { a: [['kai', 'go']], b: [] };
      const versions = {};
      const client = fakeClient(glossByDoc, versions);
      const a = docOf(client, 'a', [['kai', 'go']]);
      await openPrecedent(a);
      // Its rows are out of the count and it is folded live, so a save to it
      // from another tab changes nothing the count holds while it is open.
      glossByDoc.a = [['kai', 'eat']];
      versions.a = 2;
      await openPrecedent(a, { check: true });
      expect(projectQueries(client)).toHaveLength(1);
      // Left untouched here, it is held to the version the count listed.
      leavePrecedent(a, { wordFields: ['Gloss'] });
      const b = docOf(client, 'b');
      await openPrecedent(b);
      expect(projectQueries(client)).toHaveLength(2);
      expect(gloss(precedentBase(b))).toEqual(new Map([['eat', 1]]));
    });

    it('counts again when a document is added or deleted', async () => {
      const glossByDoc = { a: [], b: [['kai', 'go']] };
      const client = fakeClient(glossByDoc);
      const a = docOf(client, 'a');
      await openPrecedent(a);
      delete glossByDoc.b;
      await openPrecedent(a, { check: true });
      expect(projectQueries(client)).toHaveLength(2);
      expect(precedentBase(a)).not.toBeNull();
      expect(gloss(precedentBase(a))).toBeNull();
      glossByDoc.c = [['kai', 'eat']];
      await openPrecedent(a, { check: true });
      expect(projectQueries(client)).toHaveLength(3);
      expect(gloss(precedentBase(a))).toEqual(new Map([['eat', 1]]));
    });

    it('keeps what it holds when the question cannot be answered', async () => {
      const client = fakeClient({ a: [], b: [['kai', 'go']] });
      const a = docOf(client, 'a');
      await openPrecedent(a);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      client.projects.listDocuments.mockRejectedValueOnce(new Error('down'));
      await openPrecedent(a, { check: true });
      warn.mockRestore();
      expect(projectQueries(client)).toHaveLength(1);
      expect(gloss(precedentBase(a))).toEqual(new Map([['go', 1]]));
    });
  });

  it('a failed read leaves the document on its own, and is asked again only after a wait', async () => {
    const client = fakeClient({ a: [['kai', 'go']], b: [['kai', 'go']] });
    const real = client.query.getMockImplementation();
    client.query.mockImplementation(async (q) => {
      if (!q.where[0][2].doc) throw new Error('down');
      return real(q);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const a = docOf(client, 'a', [['kai', 'go']]);
    await openPrecedent(a);
    // No base at all, rather than the project's nothing less a's own rows:
    // the editor then ranks on a alone, and a's go still counts.
    expect(precedentBase(a)).toBeNull();
    expect(gloss(editorTally(a))).toEqual(new Map([['go', 1]]));
    // Every render asks: nothing is sent while the failure is recent.
    const calls = client.query.mock.calls.length;
    expect(openPrecedent(a)).toBeNull();
    expect(client.query.mock.calls.length).toBe(calls);
    client.query.mockImplementation(real);
    now.mockReturnValue(1_000_000 + 61_000);
    const b = docOf(client, 'b');
    await openPrecedent(b);
    expect(gloss(precedentBase(b))).toEqual(new Map([['go', 1]]));
    now.mockRestore();
    warn.mockRestore();
  });

  it('a document whose own read failed is not asked again on every render', async () => {
    const client = fakeClient({ a: [['kai', 'go']] });
    const real = client.query.getMockImplementation();
    client.query.mockImplementation(async (q) => {
      if (q.where[0][2].doc) throw new Error('down');
      return real(q);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = docOf(client, 'a');
    await openPrecedent(a);
    expect(precedentBase(a)).toBeNull();
    const calls = client.query.mock.calls.length;
    expect(openPrecedent(a)).toBeNull();
    expect(client.query.mock.calls.length).toBe(calls);
    warn.mockRestore();
  });

  it('a document changed since the project read reads the project again', async () => {
    const glossByDoc = { a: [], b: [['kai', 'go']] };
    const versions = {};
    const client = fakeClient(glossByDoc, versions);
    await openPrecedent(docOf(client, 'a'));
    // Someone reglosses b's kai from go to eat before b is opened here.
    glossByDoc.b = [['kai', 'eat']];
    versions.b = 2;
    const b = docOf(client, 'b', [['kai', 'eat']], 2);
    await openPrecedent(b);
    expect(projectQueries(client)).toHaveLength(2);
    expect(gloss(editorTally(b))).toEqual(new Map([['eat', 1]]));
  });

  it('a document the project read did not list reads the project again', async () => {
    const glossByDoc = { a: [] };
    const client = fakeClient(glossByDoc);
    await openPrecedent(docOf(client, 'a'));
    // Made after the project read, so none of its rows are in it.
    glossByDoc.c = [['kai', 'go']];
    const c = docOf(client, 'c', [['kai', 'go']]);
    await openPrecedent(c);
    expect(projectQueries(client)).toHaveLength(2);
    expect(gloss(editorTally(c))).toEqual(new Map([['go', 1]]));
  });

  it('a history snapshot neither reads nor leaves anything', async () => {
    const client = fakeClient({ a: [['kai', 'go']], b: [] });
    const a = docOf(client, 'a', [['kai', 'go']]);
    await openPrecedent(a);
    editGlosses(a, [['kai', 'eat']]);
    const snapshot = { ...docOf(client, 'a', [['kai', 'go']], 1), asOf: '2026-09-01T00:00:00Z' };
    const calls = client.query.mock.calls.length;
    expect(openPrecedent(snapshot)).toBeNull();
    expect(precedentBase(snapshot)).toBeNull();
    leavePrecedent(snapshot, { wordFields: ['Gloss'] });
    expect(client.query.mock.calls.length).toBe(calls);
    // The live document, back on screen after the snapshot, is still the one
    // whose edit counts once it is left.
    openPrecedent(a);
    leavePrecedent(a, { wordFields: ['Gloss'] });
    const b = docOf(client, 'b');
    await openPrecedent(b);
    expect(gloss(precedentBase(b))).toEqual(new Map([['eat', 1]]));
  });

  it('is null until both reads land', () => {
    const client = fakeClient({ a: [] });
    const a = docOf(client, 'a');
    openPrecedent(a);
    expect(precedentBase(a)).toBeNull();
  });
});
