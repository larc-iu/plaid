import { describe, it, expect, vi } from 'vitest';
import { attestedRows, loadAttested, mergeAttested, distinctValues } from './attested.js';
import { governedFreqQuery } from '../search/searchQueries.js';

// The value inventory every tagset scan reads. A morpheme field's rows carry
// how the grid reads the value, from the morpheme's morph type and form, so a
// suffix's gloss is not judged as a stem's.

const BOUND = { bound: true, beside: [] };
const morphField = { kind: 'span', scope: 'morpheme', layerId: 'msl', field: 'Gloss' };
const wordField = { kind: 'span', scope: 'word', layerId: 'wsl', field: 'Gloss' };
const metaField = { kind: 'metadata', scope: 'document', layerId: null, field: 'Genre' };

describe('governedFreqQuery', () => {
  it("groups a morpheme field's values by the morpheme's morph type and form", () => {
    const q = governedFreqQuery(morphField, 'p');
    expect(q.where).toContainEqual(['covers', '?s', '?t']);
    expect(q.return.group).toEqual(['?val', '?t.metadata.morphType', '?t.metadata.form']);
  });

  it("groups a word field's and a sentence field's by value alone", () => {
    for (const scope of ['word', 'sentence']) {
      const q = governedFreqQuery({ ...wordField, scope }, 'p');
      expect(q.return.group).toEqual(['?val']);
      expect(q.where.some((c) => c[0] === 'covers')).toBe(false);
    }
  });

  it('asks a metadata field of the document, scoped to the project', () => {
    const q = governedFreqQuery(metaField, 'p');
    expect(q.scope).toEqual({ projectIds: ['p'] });
    expect(q.return.group).toEqual(['?d.metadata.Genre']);
  });
});

describe('attestedRows', () => {
  it('reads each morpheme row by its morph type and form, one row per value and reading', () => {
    const rows = attestedRows(morphField, [
      ['sbj:3.pfv', 'suffix', 'ti', 4],
      ['sbj:3.pfv', 'suffix', 'te', 1],
      ['sbj:3.pfv', 'stem', 'sa', 9],
      ['sbj:3.pfv', null, null, 2],
      ['top', 'enclitic', 'ka', 3],
      ['PST', null, '∅', 5],
      [null, 'stem', 'x', 1],
    ]);
    expect(rows).toEqual([
      ['sbj:3.pfv', 5, BOUND],
      ['sbj:3.pfv', 11, undefined],
      ['top', 3, BOUND],
      ['PST', 5, BOUND],
    ]);
  });

  it("gives a word field's, a sentence field's and a metadata field's rows no reading", () => {
    expect(attestedRows(wordField, [['sbj:3.pfv', 4]])).toEqual([['sbj:3.pfv', 4, undefined]]);
    expect(attestedRows(metaField, [['Song', 2]])).toEqual([['Song', 2, undefined]]);
  });

  it('loads through one query per field', async () => {
    const client = { query: vi.fn(async () => ({ results: [['PL', 'suffix', 's', 3]] })) };
    expect(await loadAttested(client, 'p', morphField)).toEqual([['PL', 3, BOUND]]);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toEqual(governedFreqQuery(morphField, 'p'));
  });

  it('merges fields, a value counted once per reading', () => {
    const merged = mergeAttested([
      [
        ['PL', 3, BOUND],
        ['dog', 2, undefined],
      ],
      [
        ['PL', 1, BOUND],
        ['PL', 7, undefined],
      ],
    ]);
    expect(merged).toEqual([
      ['PL', 4, BOUND],
      ['dog', 2, undefined],
      ['PL', 7, undefined],
    ]);
    expect(distinctValues(merged)).toBe(2);
  });
});
