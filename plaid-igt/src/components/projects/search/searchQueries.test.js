import { describe, it, expect } from 'vitest';
import {
  buildMatchSpec,
  searchDomains,
  hitsQueries,
  hitsByDocQueries,
  freqQueries,
} from './searchQueries.js';

describe('buildMatchSpec', () => {
  it('contains escapes regex specials and is case-insensitive', () => {
    expect(buildMatchSpec('a.b(c', 'contains')).toEqual({ regex: 'a\\.b\\(c', flags: 'i' });
  });
  it('exact is a literal; regex passes through verbatim', () => {
    expect(buildMatchSpec('M.PL', 'exact')).toBe('M.PL');
    expect(buildMatchSpec('^nac', 'regex')).toEqual({ regex: '^nac' });
  });
});

const LAYER_INFO = {
  primaryTokenLayer: { id: 'wordL' },
  morphemeTokenLayer: { id: 'morphL' },
  spanLayers: {
    word: [{ id: 'posL', name: 'POS' }],
    morpheme: [{ id: 'glossL', name: 'Gloss' }],
    sentence: [{ id: 'trL', name: 'Translation' }],
  },
};

describe('searchDomains', () => {
  it('lists forms, fields per scope, and lexicon when vocabs exist', () => {
    const ds = searchDomains(LAYER_INFO, [{ id: 'v1' }]);
    expect(ds.map((d) => d.id)).toEqual([
      'words',
      'morphemes',
      'span:posL',
      'span:glossL',
      'span:trL',
      'lexicon',
    ]);
  });
});

describe('query shapes', () => {
  const ds = searchDomains(LAYER_INFO, [{ id: 'v1' }, { id: 'v2' }]);
  const morph = ds.find((d) => d.id === 'morphemes');
  const lex = ds.find((d) => d.id === 'lexicon');

  it('morpheme hits constrain metadata.form (not value)', () => {
    const [q] = hitsQueries(morph, 'os', 'd1');
    expect(q.where[0][2]).toEqual({ layer: 'morphL', metadata: { form: 'os' }, doc: 'd1' });
  });

  it('every hit query is scoped to one document', () => {
    // `limit` is per query, so asked project-wide the ids for a whole document
    // could fall past the cap while its grouped count stayed exact, and the
    // group rendered "24 hits" over "could not be located". Per document the
    // cap is per document.
    const word = ds.find((d) => d.id === 'words');
    const span = ds.find((d) => d.id === 'span:posL');
    expect(hitsQueries(word, 'x', 'd1')[0].where[0][2].doc).toBe('d1');
    expect(hitsQueries(span, 'x', 'd1')[0].where[0][2].doc).toBe('d1');
    // vocab-link takes no constraints, so the lexicon pins its token instead.
    const [q] = hitsQueries(lex, 'x', 'd1');
    expect(q.where.map((c) => c[0])).toEqual(['vocab', 'vocab-link', 'token']);
    expect(q.where[2][2]).toEqual({ doc: 'd1' });
  });

  it('morpheme frequencies group by the metadata dot path', () => {
    const [q] = freqQueries(morph, { regex: 'os', flags: 'i' });
    expect(q.return.group).toEqual(['?t.metadata.form']);
  });

  it('lexicon emits one query per vocab and joins through vocab-link', () => {
    expect(hitsQueries(lex, 'all')).toHaveLength(2);
    const [q] = hitsByDocQueries(lex, 'all');
    expect(q.where.map((c) => c[0])).toEqual(['vocab', 'vocab-link', 'token']);
  });

  it('token frequencies filter and bind via two clauses on the same var', () => {
    const word = ds.find((d) => d.id === 'words');
    const [q] = freqQueries(word, { regex: 'd', flags: 'i' });
    expect(q.where).toHaveLength(2);
    expect(q.where[1][2].value).toEqual({ var: '?val' });
    expect(q.return.group).toEqual(['?val']);
  });
});
