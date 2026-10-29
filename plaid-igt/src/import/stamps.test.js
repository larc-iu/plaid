import { describe, it, expect } from 'vitest';
import { importStamp, priorImports, settlePrior } from './stamps.js';

// A client holding the given documents, enough for priorImports.
const clientWith = (docs) => ({
  projects: { listDocuments: async () => docs.map(({ id, name }) => ({ id, name })) },
  documents: { get: async (id) => docs.find((d) => d.id === id) },
});

describe('importStamp', () => {
  it('marks a document with its own id and the source id', () => {
    expect(importStamp({ Genre: 'story' }, 7, 'd1')).toEqual({
      Genre: 'story',
      importSource: 'd1:7',
    });
  });

  it('drops a done mark the source metadata carries', () => {
    expect(importStamp({ Genre: 'story', importDone: true }, 'text-1', 'd1')).toEqual({
      Genre: 'story',
      importSource: 'd1:text-1',
    });
  });

  it("replaces a source mark the source metadata carries with this import's own", () => {
    expect(importStamp({ importSource: 'elsewhere' }, 'text-1', 'd1')).toEqual({
      importSource: 'd1:text-1',
    });
  });

  it('keeps a source id with a colon in it whole', async () => {
    const prior = await priorImports(
      clientWith([{ id: 'd1', name: 'S', metadata: importStamp({}, 'urn:x:1', 'd1') }]),
      'p',
    );
    expect(prior.find('urn:x:1')?.id).toBe('d1');
  });
});

// N3-IMPORT-OVER-2: a document copy carries its source's metadata, stamp
// included, so the copy was taken for the file's document. Kept, it took the
// recording; replaced, it was deleted with the person's work on it.
describe('a copy of an imported document', () => {
  const original = {
    id: 'orig',
    name: 'story',
    metadata: importStamp({}, 'story.eaf', 'orig'),
  };
  // Core's copy carries the metadata over as it is.
  const copy = { id: 'copy', name: 'story (copy)', metadata: { ...original.metadata } };

  it('is never taken for the document the file made', async () => {
    const prior = await priorImports(clientWith([original, copy]), 'p');
    expect(prior.find('story.eaf')?.id).toBe('orig');
  });

  it('is not found at all once the original is gone', async () => {
    const prior = await priorImports(clientWith([copy]), 'p');
    expect(prior.find('story.eaf')).toBeNull();
  });
});

describe('settlePrior', () => {
  const run = async (metadata, opts) => {
    const deleted = [];
    const client = {
      ...clientWith([{ id: 'd1', name: 'S', metadata }]),
      documents: {
        get: async () => ({ id: 'd1', name: 'S', metadata }),
        delete: async (id) => deleted.push(id),
      },
    };
    const prior = await priorImports(client, 'p');
    const results = { skipped: 0, redone: 0 };
    const proceed = await settlePrior(client, prior, 'a.eaf', results, opts);
    return { proceed, deleted, results };
  };
  const made = importStamp({}, 'a.eaf', 'd1');

  it('keeps a document an earlier import made, and counts it kept', async () => {
    expect(await run(made)).toEqual({
      proceed: false,
      deleted: [],
      results: { skipped: 1, redone: 0 },
    });
  });

  it('replaces it only when the run says Replace', async () => {
    expect(await run(made, { replace: true })).toEqual({
      proceed: true,
      deleted: ['d1'],
      results: { skipped: 0, redone: 1 },
    });
  });
});
