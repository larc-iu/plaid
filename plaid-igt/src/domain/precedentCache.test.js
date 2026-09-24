import { describe, it, expect, vi } from 'vitest';
import { precedentCounts } from './precedent.js';
import { leavePrecedent, openPrecedent, precedentBase } from './precedentCache.js';

const layerInfo = {
  primaryTokenLayer: { id: 'wordL' },
  morphemeTokenLayer: null,
  spanLayers: { word: [{ id: 'glossL', name: 'Gloss' }], morpheme: [], sentence: [] },
};

// A server holding one Gloss per document: rows are [form, value, prov,
// provConfirmed, count], grouped over the documents a query covers.
let logins = 0;
function fakeClient(glossByDoc) {
  const client = {
    baseUrl: 'http://core',
    token: `t${++logins}`,
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

const docOf = (client, id, glosses = []) => ({
  id,
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
    // Back to a, through a new client for the same login: nothing is asked.
    const calls = client.query.mock.calls.length;
    const again = { ...client };
    expect(openPrecedent(docOf(again, 'a'))).toBeNull();
    expect(client.query.mock.calls.length).toBe(calls);
  });

  it('a document edited and left counts as it was left in the next one', async () => {
    const client = fakeClient({ a: [['kai', 'go']], b: [] });
    const a = docOf(client, 'a');
    await openPrecedent(a);
    // The person changes a's kai from go to eat, then leaves.
    const edited = docOf(client, 'a', [['kai', 'eat']]);
    edited.dataVersion = 3;
    leavePrecedent(edited, 0, { wordFields: ['Gloss'] });
    const b = docOf(client, 'b');
    await openPrecedent(b);
    expect(gloss(precedentBase(b))).toEqual(new Map([['eat', 1]]));
  });

  it('a document left unchanged keeps its project rows', async () => {
    const client = fakeClient({ a: [['kai', 'go']], b: [] });
    await openPrecedent(docOf(client, 'a'));
    // Its local fold would say nothing (no sentences here), so an overlay
    // taken for an untouched document would lose its go.
    leavePrecedent(docOf(client, 'a'), 0, { wordFields: ['Gloss'] });
    const b = docOf(client, 'b');
    await openPrecedent(b);
    expect(gloss(precedentBase(b))).toEqual(new Map([['go', 1]]));
  });

  it('a forced read asks the project again and drops what the old read kept', async () => {
    const glossByDoc = { a: [['kai', 'go']], b: [] };
    const client = fakeClient(glossByDoc);
    await openPrecedent(docOf(client, 'a'));
    const edited = docOf(client, 'a', [['kai', 'eat']]);
    edited.dataVersion = 1;
    leavePrecedent(edited, 0, { wordFields: ['Gloss'] });
    glossByDoc.a = [['kai', 'eat']]; // saved
    const b = docOf(client, 'b');
    await openPrecedent(b);
    await openPrecedent(b, { force: true });
    expect(projectQueries(client)).toHaveLength(2);
    expect(gloss(precedentBase(b))).toEqual(new Map([['eat', 1]]));
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
    const a = docOf(client, 'a');
    await openPrecedent(a);
    expect(gloss(precedentBase(a))).toBeNull();
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

  it('is null until both reads land', () => {
    const client = fakeClient({ a: [] });
    const a = docOf(client, 'a');
    openPrecedent(a);
    expect(precedentBase(a)).toBeNull();
  });
});
