import { describe, it, expect } from 'vitest';
import { importStamp, priorImports, settlePrior } from './resume.js';

// A client holding the given documents, enough for priorImports.
const clientWith = (docs) => ({
  projects: { listDocuments: async () => docs.map(({ id, name }) => ({ id, name })) },
  documents: { get: async (id) => docs.find((d) => d.id === id) },
});

describe('importStamp', () => {
  it('marks a document begun with its own id and the source id, and done only when asked', () => {
    expect(importStamp({ Genre: 'story' }, 7, 'd1')).toEqual({
      Genre: 'story',
      importSource: 'd1:7',
    });
    expect(importStamp({ Genre: 'story' }, 7, 'd1', true)).toEqual({
      Genre: 'story',
      importSource: 'd1:7',
      importDone: true,
    });
  });

  it('drops a done mark the source metadata already carries, so a begun document is not finished', async () => {
    // A CLDF contribution column, an ELAN header property or an archive can
    // name a key importDone. The document made from it is only begun.
    const begun = importStamp({ Genre: 'story', importDone: true }, 'text-1', 'd1');
    expect(begun).toEqual({ Genre: 'story', importSource: 'd1:text-1' });
    const prior = await priorImports(
      clientWith([{ id: 'd1', name: 'Story', metadata: begun }]),
      'p',
    );
    expect(prior.done(prior.find('text-1'))).toBe(false);
  });

  it("replaces a source mark the source metadata carries with this import's own", () => {
    expect(importStamp({ importSource: 'elsewhere' }, 'text-1', 'd1')).toEqual({
      importSource: 'd1:text-1',
    });
  });

  it('keeps a source id with a colon in it whole', async () => {
    const prior = await priorImports(
      clientWith([{ id: 'd1', name: 'S', metadata: importStamp({}, 'urn:x:1', 'd1', true) }]),
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
    metadata: importStamp({}, 'story.eaf', 'orig', true),
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
  const begun = importStamp({}, 'a.eaf', 'd1');

  it('redoes an unfinished document on a resume', async () => {
    expect(await run(begun)).toEqual({
      proceed: true,
      deleted: ['d1'],
      results: { skipped: 0, redone: 1 },
    });
  });

  // N3-IMPORT-OVER-1: outside a resume the document may hold someone's work.
  it('keeps an unfinished document when asked to, and counts it kept', async () => {
    expect(await run(begun, { keepUnfinished: true })).toEqual({
      proceed: false,
      deleted: [],
      results: { skipped: 1, redone: 0 },
    });
  });

  it('replaces it only when the run says Replace', async () => {
    expect(await run(begun, { keepUnfinished: true, replace: true })).toMatchObject({
      proceed: true,
      deleted: ['d1'],
    });
  });
});
