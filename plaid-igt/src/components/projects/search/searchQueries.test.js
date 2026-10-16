import { describe, it, expect } from 'vitest';
import {
  buildMatchSpec,
  searchDomains,
  hitsQueries,
  hitsByDocQueries,
  freqQueries,
  metadataHitsQuery,
} from './searchQueries.js';
import { PatternError } from '@ui/domain/javaRegex.js';

// The never-matching branch every server pattern ends in (javaRegex.js).
const S = `(?:(?!)${String.fromCodePoint(0x10ffff)})?`;

describe('buildMatchSpec', () => {
  // The server gets no case flag: each letter is written as the letters it
  // folds with, which the browser reads the same way.
  it('contains is a literal in any case, with no flag', () => {
    expect(buildMatchSpec('a.b(c', 'contains')).toEqual({ regex: '[Aa]\\x2e[Bb]\\x28[Cc]' + S });
    expect(buildMatchSpec('ц', 'contains')).toEqual({ regex: '[Цц]' + S });
  });
  it('exact is a literal, regex is read as Java syntax', () => {
    expect(buildMatchSpec('M.PL', 'exact')).toBe('M.PL');
    expect(buildMatchSpec('^nac', 'regex')).toEqual({ regex: '^nac' + S });
    expect(buildMatchSpec('\\p{L}', 'regex')).toEqual({ regex: '\\p{L}' + S });
  });
  it("throws a PatternError for a pattern it cannot read the server's way", () => {
    expect(() => buildMatchSpec('[[:alpha:]]', 'regex')).toThrow(PatternError);
    expect(() => buildMatchSpec('(', 'regex')).toThrow('Unclosed group.');
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
    expect(q.where[0][2]).toEqual({
      layer: 'morphL',
      metadata: { form: { literal: 'os' } },
      doc: 'd1',
    });
  });

  // A bare metadata value beginning with "?" is a variable to the engine, and
  // the search answered 400. An exact form is always sent as a literal.
  it('an exact morpheme form or document value is sent as a literal', () => {
    const forms = [
      hitsQueries(morph, '?a', 'd1')[0].where[0][2].metadata.form,
      hitsByDocQueries(morph, '?a')[0].where[0][2].metadata.form,
      freqQueries(morph, '?a')[0].where[0][2].metadata.form,
    ];
    expect(forms).toEqual([{ literal: '?a' }, { literal: '?a' }, { literal: '?a' }]);
    expect(metadataHitsQuery('p1', 'Genre', '?').where[0][2].metadata).toEqual({
      Genre: { literal: '?' },
    });
    // A pattern stays a pattern.
    expect(hitsQueries(morph, { regex: 'os' }, 'd1')[0].where[0][2].metadata.form).toEqual({
      regex: 'os',
    });
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

describe('a words search under the ignored-tokens rule', () => {
  const info = {
    ...LAYER_INFO,
    primaryTokenLayer: {
      id: 'wordL',
      config: { igt: { ignoredTokens: { type: 'unicodePunctuation', whitelist: [] } } },
    },
  };
  const words = searchDomains(info, []).find((d) => d.id === 'words');
  const keep = ['token', '?t', { value: words.wordValue }];

  it('finds and counts words only, never a token the rule ignores', () => {
    expect(words.wordValue.regex).toMatch(/^\[\^\\p\{P\}\\p\{S\}\]/);
    expect(hitsQueries(words, 'x', 'd1')[0].where).toContainEqual(keep);
    expect(hitsByDocQueries(words, 'x')[0].where).toContainEqual(keep);
    expect(freqQueries(words, 'x')[0].where).toContainEqual(keep);
  });
});

describe('a Morphemes search', () => {
  const morphemes = searchDomains(LAYER_INFO, []).find((d) => d.id === 'morphemes');
  const formless = (where) =>
    where.some((c) => c[0] === 'not' && c[1]?.[2]?.metadata?.form?.regex === '.');

  it('also finds a stored morpheme with no form, alone in its word, by its surface', () => {
    const [byForm, bySurface] = hitsQueries(morphemes, 'kai', 'd1');
    expect(byForm.where[0][2].metadata.form).toEqual({ literal: 'kai' });
    expect(bySurface.where[0]).toEqual([
      'token',
      '?t',
      { layer: 'morphL', doc: 'd1', begin: { var: '?fb' }, end: { var: '?fe' }, value: 'kai' },
    ]);
    expect(formless(bySurface.where)).toBe(true);
    expect(hitsByDocQueries(morphemes, 'kai')).toHaveLength(2);
    expect(freqQueries(morphemes, 'kai', { formless: true })).toHaveLength(2);
  });

  it("leaves it out of the frequency query Validation's sweep reads", () => {
    expect(freqQueries(morphemes, 'kai')).toHaveLength(1);
  });
});
