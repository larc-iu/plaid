import { describe, it, expect, vi } from 'vitest';
import { attestedRows, loadAttested, mergeAttested, distinctValues } from './attested.js';
import { governedFreqQueries, headwordTypesQuery } from '../search/searchQueries.js';

// The value inventory every tagset scan reads. A morpheme field's rows carry
// how the grid reads the value, from the morpheme's morph type and form, so a
// suffix's gloss is not judged as a stem's.

const BOUND = { bound: true, beside: [] };
const morphField = { kind: 'span', scope: 'morpheme', layerId: 'msl', field: 'Gloss' };
const wordField = { kind: 'span', scope: 'word', layerId: 'wsl', field: 'Gloss' };
const metaField = { kind: 'metadata', scope: 'document', layerId: null, field: 'Genre' };

describe('governedFreqQueries', () => {
  it("asks a morpheme field's linked morphemes for their entry's type and the rest for their own", () => {
    const [linked, unlinked, ...rest] = governedFreqQueries(morphField, 'p');
    expect(rest).toEqual([]);
    expect(linked.where).toContainEqual(['covers', '?s', '?t']);
    expect(linked.where).toContainEqual(['vocab-link', '?t', '?v']);
    expect(linked.return.group).toEqual([
      '?val',
      '?v.metadata.morphType',
      '?v.metadata.parent',
      '?t.metadata.morphType',
      '?t.metadata.form',
    ]);
    expect(unlinked.where).toContainEqual(['not', ['vocab-link', '?t', '?v']]);
    expect(unlinked.return.group).toEqual(['?val', '?t.metadata.morphType', '?t.metadata.form']);
  });

  it("groups a word field's and a sentence field's by value alone", () => {
    for (const scope of ['word', 'sentence']) {
      const [q, ...rest] = governedFreqQueries({ ...wordField, scope }, 'p');
      expect(rest).toEqual([]);
      expect(q.return.group).toEqual(['?val']);
      expect(q.where.some((c) => c[0] === 'covers')).toBe(false);
    }
  });

  it('asks a metadata field of the document, scoped to the project', () => {
    const [q] = governedFreqQueries(metaField, 'p');
    expect(q.scope).toEqual({ projectIds: ['p'] });
    expect(q.return.group).toEqual(['?d.metadata.Genre']);
  });

  it('asks for every headword, scoped to the project', () => {
    const q = headwordTypesQuery('p');
    expect(q.scope).toEqual({ projectIds: ['p'] });
    expect(q.return.group).toEqual(['?h', '?h.metadata.morphType', '?h.metadata.parent']);
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

  it('loads a word field through one query', async () => {
    const client = { query: vi.fn(async () => ({ results: [['PL', 3]] })) };
    expect(await loadAttested(client, 'p', wordField)).toEqual([['PL', 3, undefined]]);
    expect(client.query).toHaveBeenCalledTimes(1);
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

// A fake server over morphemes and a lexicon, answering each query by its
// shape: the morphemes a vocab link reaches, the ones none does, every
// morpheme by its cached type (an ungrouped-by-entry query), or the headwords.
const serverOver = (morphemes, lexicon) => {
  const byId = new Map(lexicon.map((e) => [e.id, e]));
  const tally = (rows) => {
    const out = new Map();
    for (const r of rows) {
      const k = JSON.stringify(r);
      out.set(k, (out.get(k) || 0) + 1);
    }
    return [...out].map(([k, n]) => [...JSON.parse(k), n]);
  };
  const has = (q, head) => q.where.some((c) => c[0] === head);
  return {
    query: vi.fn(async (q) => {
      if (has(q, 'vocab')) {
        const heads = new Set(lexicon.map((e) => e.parent).filter(Boolean));
        return {
          results: tally(
            [...heads].map((id) => [id, byId.get(id)?.type ?? null, byId.get(id)?.parent ?? null]),
          ),
        };
      }
      if (has(q, 'vocab-link')) {
        return {
          results: tally(
            morphemes
              .filter((m) => m.entry)
              .map((m) => {
                const e = byId.get(m.entry);
                return [m.gloss, e.type ?? null, e.parent ?? null, m.cached ?? null, m.form];
              }),
          ),
        };
      }
      const rows = has(q, 'not') ? morphemes.filter((m) => !m.entry) : morphemes;
      return { results: tally(rows.map((m) => [m.gloss, m.cached ?? null, m.form])) };
    }),
  };
};

describe("a linked morpheme's type", () => {
  // The grid takes a linked morpheme's type from its lexicon entry, and the
  // token's cached type is refreshed only when its document is opened.

  it("is its entry's, not the token's stale cached one", async () => {
    const client = serverOver(
      [{ gloss: 'sbj:3.pfv', cached: 'stem', form: 'ti', entry: 'e1' }],
      [{ id: 'e1', type: 'suffix' }],
    );
    expect(await loadAttested(client, 'p', morphField)).toEqual([['sbj:3.pfv', 1, BOUND]]);
  });

  it("is its headword's for a sense with none of its own, a level up or more", async () => {
    const client = serverOver(
      [
        { gloss: 'sbj:3.pfv', cached: 'stem', form: 'ti', entry: 's1' },
        { gloss: 'sbj:3.pfv', cached: 'stem', form: 'ti', entry: 's2' },
      ],
      [
        { id: 'h', type: 'suffix' },
        { id: 's1', parent: 'h' },
        { id: 's2', parent: 's1' },
      ],
    );
    expect(await loadAttested(client, 'p', morphField)).toEqual([['sbj:3.pfv', 2, BOUND]]);
  });

  it("falls back to the token's cached type when nothing on the entry's chain has one", async () => {
    const client = serverOver(
      [
        { gloss: 'sbj:3.pfv', cached: 'suffix', form: 'ti', entry: 's1' },
        { gloss: 'sbj:3.pfv', cached: 'stem', form: 'sa', entry: 'e2' },
        { gloss: 'PL', cached: 'suffix', form: 's' },
      ],
      [{ id: 'h' }, { id: 's1', parent: 'h' }, { id: 'e2' }],
    );
    expect(await loadAttested(client, 'p', morphField)).toEqual([
      ['sbj:3.pfv', 1, BOUND],
      ['sbj:3.pfv', 1, undefined],
      ['PL', 1, BOUND],
    ]);
  });

  it('asks for the headwords only when a linked entry has no type of its own', async () => {
    const client = serverOver(
      [{ gloss: 'PL', cached: 'stem', form: 's', entry: 'e1' }],
      [{ id: 'e1', type: 'suffix' }],
    );
    await loadAttested(client, 'p', morphField);
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
