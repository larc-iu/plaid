import { describe, it, expect } from 'vitest';
import { importStamp, priorImports, settlePrior, unusedName } from './resume.js';

// H12-IO-3: a file whose name is decomposed (macOS writes `é` as `e` and a
// combining accent) was never found again. The server stores the stamp and
// the document's name composed, and the lookup used the name as given.

const NFD = 'Kafe\u0301 nin\u0303o.eaf';
const NFC = NFD.normalize('NFC');

// What the server stores: every string composed.
const stored = (metadata) =>
  Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v).normalize('NFC')]));

const clientWith = (docs) => {
  const deleted = [];
  return {
    deleted,
    projects: { listDocuments: async () => docs.map(({ id, name }) => ({ id, name })) },
    documents: {
      get: async (id) => docs.find((d) => d.id === id),
      delete: async (id) => deleted.push(id),
    },
  };
};

describe('a source named in the other Unicode spelling', () => {
  it('is stamped composed and found by either spelling', async () => {
    expect(importStamp({}, NFD, 'd1').importSource).toBe(`d1:${NFC}`);
    const begun = stored(importStamp({}, NFD, 'd1'));
    const prior = await priorImports(
      clientWith([{ id: 'd1', name: 'Kaf\u00e9 ni\u00f1o', metadata: begun }]),
      'p',
    );
    expect(prior.find(NFD)?.id).toBe('d1');
    expect(prior.find(NFC)?.id).toBe('d1');
  });

  it('has its half-made document redone on a resume, not left beside a second', async () => {
    const begun = stored(importStamp({}, NFD, 'd1'));
    const client = clientWith([{ id: 'd1', name: 'Kaf\u00e9 ni\u00f1o', metadata: begun }]);
    const prior = await priorImports(client, 'p');
    const results = { skipped: 0, redone: 0 };
    expect(await settlePrior(client, prior, NFD, results)).toBe(true);
    expect(client.deleted).toEqual(['d1']);
    expect(results.redone).toBe(1);
  });

  it('is named as a copy beside the document of that name', async () => {
    const prior = await priorImports(
      clientWith([{ id: 'd1', name: 'Kaf\u00e9 ni\u00f1o', metadata: {} }]),
      'p',
    );
    expect(unusedName('Kafe\u0301 nin\u0303o', prior.names)).toBe('Kaf\u00e9 ni\u00f1o (2)');
  });
});
