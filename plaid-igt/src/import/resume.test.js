import { describe, it, expect } from 'vitest';
import { importStamp, priorImports } from './resume.js';

// A client holding the given documents, enough for priorImports.
const clientWith = (docs) => ({
  projects: { listDocuments: async () => docs.map(({ id, name }) => ({ id, name })) },
  documents: { get: async (id) => docs.find((d) => d.id === id) },
});

describe('importStamp', () => {
  it('marks a document begun with the source id, and done only when asked', () => {
    expect(importStamp({ Genre: 'story' }, 7)).toEqual({ Genre: 'story', importSource: '7' });
    expect(importStamp({ Genre: 'story' }, 7, true)).toEqual({
      Genre: 'story',
      importSource: '7',
      importDone: true,
    });
  });

  it('drops a done mark the source metadata already carries, so a begun document is not finished', async () => {
    // A CLDF contribution column, an ELAN header property or an archive can
    // name a key importDone. The document made from it is only begun.
    const begun = importStamp({ Genre: 'story', importDone: true }, 'text-1');
    expect(begun).toEqual({ Genre: 'story', importSource: 'text-1' });
    const prior = await priorImports(
      clientWith([{ id: 'd1', name: 'Story', metadata: begun }]),
      'p',
    );
    expect(prior.done(prior.find('text-1'))).toBe(false);
  });

  it("replaces a source mark the source metadata carries with this import's own", () => {
    expect(importStamp({ importSource: 'elsewhere' }, 'text-1')).toEqual({
      importSource: 'text-1',
    });
  });
});
