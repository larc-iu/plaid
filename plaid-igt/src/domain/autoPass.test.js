import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBuiltinAnalysis } from './autoPass.js';

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
  it('reads it from the project read the editor already made', async () => {
    const { openPrecedent } = await import('./precedentCache.js');
    const doc = {
      id: 'doc-under-test',
      projectId: 'p1',
      sentences: [{ tokens: [] }],
      layerInfo: {
        primaryTokenLayer: { id: 'word-layer', config: {} },
        morphemeTokenLayer: null,
        spanLayers: { word: [], morpheme: [], sentence: [] },
      },
      vocabularies: { v1: { id: 'v1', items: [] } },
      dataVersion: 0,
      client: {
        baseUrl: 'http://core',
        token: 'autopass-link',
        query: vi.fn(async () => ({ results: [] })),
      },
    };
    await openPrecedent(doc);
    const projectWide = () =>
      doc.client.query.mock.calls.filter(([q]) => !q.where.some((c) => c[2]?.doc)).length;
    const before = projectWide();
    const res = await runBuiltinAnalysis(doc, { copy: false, link: true });
    expect(res.ok).toBe(true);
    expect(projectWide()).toBe(before);
  });
});
