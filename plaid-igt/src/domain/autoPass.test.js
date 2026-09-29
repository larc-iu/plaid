import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { runBuiltinAnalysis } from './autoPass.js';

// A phase that writes stamps its rule's version, whose source texts are a
// module loaded on first use. Loaded here, outside any test's timeout: in a
// busy full run its first transform can take longer than one.
beforeAll(() => import('./builtinSourceTexts.js'), 60000);

// The stop contract of the built-in phases. These are the two Auto-analyze
// steps with no service behind them, so nothing else can report a stop for
// them: the checkpoints here are the whole mechanism.
//
// The precedent gather is what this is really about: up to 25 other documents
// read a few at a time, the longest silence in the app.

// A word with no analysis at all, which is what the copy phase looks for.
const unanalyzed = (content) => ({
  content,
  annotations: {},
  morphemes: [{ annotations: {}, metadata: {} }],
});

// The least document runCopyPhase will work on: one sentence of unanalyzed
// words, the two token layers it insists on, and a client whose precedent
// index names `docCount` other documents holding the same forms.
const makeDoc = (docCount, { onGet } = {}) => {
  const forms = ['aq', 'be'];
  const results = [];
  for (let i = 0; i < docCount; i++) for (const f of forms) results.push([`src-${i}`, f, 10 - i]);
  const gets = [];
  return {
    id: 'doc-under-test',
    sentences: [{ tokens: forms.map(unanalyzed) }],
    layerInfo: {
      primaryTokenLayer: { id: 'word-layer', config: {} },
      morphemeTokenLayer: { id: 'morpheme-layer' },
    },
    vocabularies: {},
    gets,
    client: {
      query: vi.fn(async () => ({ results })),
      documents: {
        get: vi.fn(async (id) => {
          gets.push(id);
          onGet?.(gets.length);
          // A source that cannot be read is skipped, not fatal, which keeps
          // this test about the loop rather than about IgtDocument.
          throw new Error('unreadable');
        }),
      },
    },
    bulkApplyAnalyses: vi.fn(async () => 0),
  };
};

const copyAll = { segmentation: true, links: true, fields: true };

describe('runBuiltinAnalysis: stopping', () => {
  let warn;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('reports stopped without writing when the stop is already set', async () => {
    const doc = makeDoc(3);
    const res = await runBuiltinAnalysis(doc, {
      copy: true,
      link: false,
      copyContents: copyAll,
      shouldStop: () => true,
    });
    expect(res).toEqual({ copied: 0, linked: 0, ok: true, stopped: true });
    expect(doc.gets).toHaveLength(0);
    expect(doc.bulkApplyAnalyses).not.toHaveBeenCalled();
  });

  it('leaves the precedent loop at the next document, not at the end of it', async () => {
    let stop = false;
    // Asked to stop while the second document is being read.
    const doc = makeDoc(8, {
      onGet: (n) => {
        if (n === 2) stop = true;
      },
    });
    const res = await runBuiltinAnalysis(doc, {
      copy: true,
      link: false,
      copyContents: copyAll,
      shouldStop: () => stop,
    });
    expect(res.stopped).toBe(true);
    expect(res.ok).toBe(true);
    // The reads already under way finish; none starts after the stop, so
    // at most the four in flight of the eight.
    expect(doc.gets.slice(0, 2)).toEqual(['src-0', 'src-1']);
    expect(doc.gets.length).toBeLessThanOrEqual(4);
    expect(doc.bulkApplyAnalyses).not.toHaveBeenCalled();
  });

  it('reports no progress once stopped, from the reads still in flight', async () => {
    let stop = false;
    const doc = makeDoc(10);
    // Each read takes a moment, the first one longest: the stop lands while
    // the other three are still out.
    doc.client.documents.get = vi.fn(async (id) => {
      doc.gets.push(id);
      await new Promise((r) => setTimeout(r, id === 'src-0' ? 1 : 20));
      if (id === 'src-0') stop = true;
      throw new Error('unreadable');
    });
    const messages = [];
    let returned = false;
    const res = await runBuiltinAnalysis(doc, {
      copy: true,
      link: false,
      copyContents: copyAll,
      shouldStop: () => stop,
      onProgress: ({ message }) => returned && messages.push(message),
    });
    returned = true;
    expect(res.stopped).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toEqual([]);
  });

  it('runs to the end and reports stopped: false when nothing asks it to stop', async () => {
    const doc = makeDoc(3);
    const res = await runBuiltinAnalysis(doc, { copy: true, link: false, copyContents: copyAll });
    expect(res).toEqual({ copied: 0, linked: 0, ok: true, stopped: false });
    expect(doc.gets).toEqual(['src-0', 'src-1', 'src-2']);
  });

  it('defaults to uncancellable, so callers that pass no shouldStop are unchanged', async () => {
    const doc = makeDoc(2);
    const res = await runBuiltinAnalysis(doc, { copy: true, link: false, copyContents: copyAll });
    expect(res.stopped).toBe(false);
    expect(doc.client.query).toHaveBeenCalledTimes(1);
  });

  it('does not stop between deciding to write and writing', async () => {
    // Every checkpoint answers "stop", so if the write were reachable after one
    // it would run anyway. It must not be reached at all.
    const doc = makeDoc(1);
    doc.sentences = [{ tokens: [unanalyzed('aq')] }];
    const res = await runBuiltinAnalysis(doc, {
      copy: true,
      link: false,
      copyContents: copyAll,
      shouldStop: () => true,
    });
    expect(res.stopped).toBe(true);
    expect(doc.bulkApplyAnalyses).not.toHaveBeenCalled();
  });
});

describe('runBuiltinAnalysis: reading the source documents', () => {
  it('reads a few at a time, never more than four', async () => {
    let inFlight = 0;
    let most = 0;
    const doc = makeDoc(10);
    doc.client.documents.get = vi.fn(async (id) => {
      doc.gets.push(id);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      throw new Error('unreadable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runBuiltinAnalysis(doc, { copy: true, link: false, copyContents: copyAll });
    warn.mockRestore();
    expect(res.stopped).toBe(false);
    expect(doc.gets).toHaveLength(10);
    expect(most).toBe(4);
  });
});

describe('runBuiltinAnalysis: link precedent', () => {
  // Auto-analyze in b writes by what the project holds when it runs, not by
  // a read the editor took earlier, which can predate someone's relinking in
  // another document.
  const items = [
    { id: 'kai1', form: 'kai' },
    { id: 'kai2', form: 'kai' },
  ];
  const linked = (id) => ({ content: 'kai', vocabItem: { id, prov: 'human' }, morphemes: [] });
  const makeLinkDoc = (server, id = 'b') => ({
    id,
    projectId: 'p1',
    raw: { id, version: 1 },
    sentences: [
      {
        tokens: [
          ...server[id].map(linked),
          { id: 't-open', content: 'kai', vocabItem: null, morphemes: [] },
        ],
      },
    ],
    layerInfo: {
      primaryTokenLayer: { id: 'word-layer', config: {} },
      morphemeTokenLayer: null,
      spanLayers: { word: [], morpheme: [], sentence: [] },
    },
    vocabularies: { v1: { id: 'v1', items } },
    dataVersion: 0,
    whenSaved: async () => {},
    client: {
      withOperation: async (_label, fn) => fn(),
      baseUrl: 'http://core',
      token: 'autopass-link',
      projects: {
        listDocuments: async () => Object.keys(server).map((d) => ({ id: d, version: 1 })),
      },
      // Link rows [item, ?, form, kind, ?, count] over the documents asked for.
      query: vi.fn(async (q) => {
        const scope = q.where.map((c) => c[2]?.doc).find(Boolean);
        if (!q.where.some((c) => c[0] === 'vocab-link')) return { results: [] };
        const counts = new Map();
        for (const [d, links] of Object.entries(server)) {
          if (scope && d !== scope) continue;
          for (const id of links) counts.set(id, (counts.get(id) || 0) + 1);
        }
        return { results: [...counts].map(([id, n]) => [id, null, 'kai', 'word', null, n]) };
      }),
    },
    bulkLinkVocab: vi.fn(async (proposals) => proposals.length),
    bulkLinkMwes: vi.fn(async () => 0),
  });

  it('asks the project when it runs, not an older read the editor holds', async () => {
    const { openPrecedent } = await import('./precedentCache.js');
    const server = { a: ['kai1', 'kai1'], b: [] };
    await openPrecedent(makeLinkDoc(server, 'a')); // the editor's read, in a
    server.a = ['kai2', 'kai2']; // someone relinks a since
    const doc = makeLinkDoc(server);
    await openPrecedent(doc); // b opens
    const res = await runBuiltinAnalysis(doc, { copy: false, link: true });
    expect(res.ok).toBe(true);
    expect(doc.bulkLinkVocab.mock.calls[0][0].map((p) => p.vocabItemId)).toEqual(['kai2']);
  });

  it('follows the links made in this project, not in another project sharing the vocabulary', async () => {
    const server = { a: ['kai1'], b: [] };
    const doc = makeLinkDoc(server);
    const inProject = doc.client.query;
    // Project p2 links kai to kai2 three times over the same vocabulary.
    doc.client.query = vi.fn(async (q) => {
      const own = await inProject(q);
      if (
        q.scope?.projectIds?.includes('p2') === false ||
        !q.where.some((c) => c[0] === 'vocab-link')
      )
        return own;
      return { results: [...own.results, ['kai2', null, 'kai', 'word', null, 3]] };
    });
    const res = await runBuiltinAnalysis(doc, { copy: false, link: true });
    expect(res.ok).toBe(true);
    expect(doc.client.query.mock.calls.every(([q]) => q.scope?.projectIds?.join() === 'p1')).toBe(
      true,
    );
    expect(doc.bulkLinkVocab.mock.calls[0][0].map((p) => p.vocabItemId)).toEqual(['kai1']);
  });

  it('fails the run when the project cannot be asked, rather than linking without it', async () => {
    const server = { b: ['kai2', 'kai2'] };
    const doc = makeLinkDoc(server);
    doc.client.query.mockRejectedValue(new Error('504'));
    await expect(runBuiltinAnalysis(doc, { copy: false, link: true })).rejects.toThrow('504');
    expect(doc.bulkLinkVocab).not.toHaveBeenCalled();
  });
});
