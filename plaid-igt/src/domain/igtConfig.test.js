import { describe, it, expect } from 'vitest';
import { ROLES } from '@larc-iu/plaid-client';
import {
  findBaselineTextLayer,
  findWordTokenLayer,
  findSentenceTokenLayer,
  findMorphemeTokenLayer,
  findAlignmentTokenLayer,
  readScope,
  readOrthographies,
  readIgnoredTokens,
  readDocumentMetadata,
  readInitialized,
  readVocabFields,
  isTokenIgnored,
  trimIgnoredEdges,
  readLanguages,
  hasLanguageIdentity,
} from './igtConfig.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { buildRawDoc } from './test-helpers.js';

describe('igtConfig substrate finders (by shared role)', () => {
  const raw = buildRawDoc();
  const textLayers = raw.textLayers;
  const tokenLayers = textLayers[0].tokenLayers;

  it('finds the baseline text layer by role', () => {
    expect(findBaselineTextLayer(textLayers)?.id).toBe('tl-1');
  });

  it('finds sentence / word / morpheme / alignment token layers by role', () => {
    expect(findSentenceTokenLayer(tokenLayers)?.id).toBe('sentL');
    expect(findWordTokenLayer(tokenLayers)?.id).toBe('wordL');
    expect(findMorphemeTokenLayer(tokenLayers)?.id).toBe('morphL');
    expect(findAlignmentTokenLayer(tokenLayers)?.id).toBe('alignL');
  });

  it('returns null when no layer carries the role', () => {
    expect(findWordTokenLayer([{ config: { plaid: { role: ROLES.SENTENCE } } }])).toBeNull();
    expect(findBaselineTextLayer([])).toBeNull();
    expect(findBaselineTextLayer(undefined)).toBeNull();
  });
});

describe('igtConfig private readers (igt namespace only)', () => {
  it('reads its private config from the igt namespace', () => {
    expect(readScope({ igt: { scope: 'Word' } })).toBe('Word');
    expect(readOrthographies({ igt: { orthographies: [{ name: 'IPA' }] } })).toEqual([
      { name: 'IPA' },
    ]);
    expect(readIgnoredTokens({ igt: { ignoredTokens: { type: 'blacklist' } } })).toEqual({
      type: 'blacklist',
    });
    expect(readDocumentMetadata({ igt: { documentMetadata: [{ name: 'Date' }] } })).toEqual([
      { name: 'Date' },
    ]);
    expect(readInitialized({ igt: { initialized: true } })).toBe(true);
    expect(readVocabFields({ igt: { fields: { Gloss: { inline: true } } } })).toEqual({
      Gloss: { inline: true },
    });
  });

  it('does NOT fall back to the legacy plaid namespace (clean break)', () => {
    expect(readScope({ plaid: { scope: 'Word' } })).toBeNull();
    expect(readInitialized({ plaid: { initialized: true } })).toBe(false);
    expect(readOrthographies({ plaid: { orthographies: [{ name: 'IPA' }] } })).toBeNull();
  });

  it('returns null / false on missing config', () => {
    expect(readScope(undefined)).toBeNull();
    expect(readInitialized(undefined)).toBe(false);
    expect(readOrthographies(null)).toBeNull();
  });
});

describe('getIgtLayerInfo binds the new shape', () => {
  it('resolves all substrate layers and buckets spans by igt scope', () => {
    const info = getIgtLayerInfo(buildRawDoc());
    expect(info.primaryTextLayer?.id).toBe('tl-1');
    expect(info.primaryTokenLayer?.id).toBe('wordL');
    expect(info.sentenceTokenLayer?.id).toBe('sentL');
    expect(info.morphemeTokenLayer?.id).toBe('morphL');
    expect(info.alignmentTokenLayer?.id).toBe('alignL');
    expect(info.spanLayers.word.map((l) => l.name)).toEqual(['POS']);
    expect(info.spanLayers.morpheme.map((l) => l.name)).toEqual(['Gloss']);
    expect(info.spanLayers.sentence.map((l) => l.name)).toEqual(['Translation']);
  });
});

describe('ignored-tokens rule', () => {
  const cfg = { type: 'unicodePunctuation', whitelist: ['?'] };
  it('ignores pure punctuation/symbol tokens, honoring the whitelist', () => {
    expect(isTokenIgnored('.', cfg)).toBe(true);
    expect(isTokenIgnored('...', cfg)).toBe(true);
    expect(isTokenIgnored('$', cfg)).toBe(true);
    expect(isTokenIgnored('?', cfg)).toBe(false); // whitelisted
    expect(isTokenIgnored('word', cfg)).toBe(false);
    expect(isTokenIgnored('word.', cfg)).toBe(false);
  });
  it('does NOT ignore emoji / pictographs (they are annotatable word-like units)', () => {
    expect(isTokenIgnored('😀', cfg)).toBe(false);
    expect(isTokenIgnored('👍🏽', cfg)).toBe(false);
  });
  it('blacklist type matches whole tokens only', () => {
    expect(isTokenIgnored('um', { type: 'blacklist', blacklist: ['um'] })).toBe(true);
    expect(isTokenIgnored('umm', { type: 'blacklist', blacklist: ['um'] })).toBe(false);
  });
  it('treats a letter-like character as a letter, however many of them', () => {
    // The list is characters, not whole tokens: a word spelled with a glottal
    // mark is a word, and so is the mark on its own.
    expect(isTokenIgnored("'", cfg)).toBe(true); // not listed here
    const glottal = { type: 'unicodePunctuation', whitelist: ["'"] };
    expect(isTokenIgnored("'", glottal)).toBe(false);
    expect(isTokenIgnored("''", glottal)).toBe(false);
    expect(isTokenIgnored("k'", glottal)).toBe(false);
    // One letter-like character does not rescue the punctuation beside it.
    expect(isTokenIgnored("'.", glottal)).toBe(false);
    expect(isTokenIgnored('.', glottal)).toBe(true);
  });
  it('needs no entry for a mark Unicode already calls a letter', () => {
    // U+02BC MODIFIER LETTER APOSTROPHE is Lm, so it is not punctuation to
    // either rule and never had to be listed. A project that types the ASCII
    // apostrophe does have to list it.
    expect(isTokenIgnored('kʼ', cfg)).toBe(false);
    expect(isTokenIgnored('ʼ', cfg)).toBe(false);
  });
  it('ignores an entry that is more than one character', () => {
    // A real project had ["-ab"]. Nothing compares a whole string to a
    // character, so it does nothing rather than quietly meaning something.
    const multi = { type: 'unicodePunctuation', whitelist: ['-ab'] };
    expect(isTokenIgnored('-', multi)).toBe(true);
    expect(isTokenIgnored('--', multi)).toBe(true);
  });
});

describe('trimIgnoredEdges', () => {
  const cfg = { type: 'unicodePunctuation', whitelist: [] };
  it('strips edge punctuation by the same rule, keeping interior punctuation', () => {
    expect(trimIgnoredEdges('derechos.', cfg)).toBe('derechos');
    expect(trimIgnoredEdges('¿Qué?', cfg)).toBe('Qué');
    expect(trimIgnoredEdges('"hello,"', cfg)).toBe('hello');
    expect(trimIgnoredEdges("dog's", cfg)).toBe("dog's");
    expect(trimIgnoredEdges('ngo-ko', cfg)).toBe('ngo-ko');
  });
  it('never trims to empty and leaves emoji alone', () => {
    expect(trimIgnoredEdges('...', cfg)).toBe('...');
    expect(trimIgnoredEdges('😀!', cfg)).toBe('😀');
    expect(trimIgnoredEdges('', cfg)).toBe('');
  });
  it('is a no-op without a unicodePunctuation config', () => {
    expect(trimIgnoredEdges('derechos.', null)).toBe('derechos.');
    expect(trimIgnoredEdges('derechos.', { type: 'blacklist', blacklist: [] })).toBe('derechos.');
  });
  it('never trims a letter-like character, at either edge', () => {
    // The character joins the word in the tokenizer, so shaving it off here
    // would hand the lexicon a form the text does not contain. This is the
    // half that used to disagree: `'abc` tokenized whole, then entered the
    // lexicon as `abc`.
    const glottal = { type: 'unicodePunctuation', whitelist: ["'"] };
    expect(trimIgnoredEdges("'abc", glottal)).toBe("'abc");
    expect(trimIgnoredEdges("abc'", glottal)).toBe("abc'");
    expect(trimIgnoredEdges("'abc'", glottal)).toBe("'abc'");
    // Still trimmed where the project has not claimed it.
    expect(trimIgnoredEdges("'abc", cfg)).toBe('abc');
    // And ordinary punctuation outside it still goes.
    expect(trimIgnoredEdges("“'abc'”", glottal)).toBe("'abc'");
  });
});

describe('readLanguages', () => {
  it('reads both languages and coerces coordinates to numbers', () => {
    const config = {
      igt: {
        languages: {
          object: {
            name: ' Lezgian ',
            glottocode: 'lezg1247',
            iso639P3: 'lez',
            latitude: '41.5',
            longitude: 48,
          },
          meta: { name: 'English', iso639P3: 'eng' },
        },
      },
    };
    expect(readLanguages(config)).toEqual({
      object: {
        name: 'Lezgian',
        glottocode: 'lezg1247',
        iso639P3: 'lez',
        tag: '',
        latitude: 41.5,
        longitude: 48,
      },
      meta: {
        name: 'English',
        glottocode: '',
        iso639P3: 'eng',
        tag: '',
        latitude: null,
        longitude: null,
      },
    });
  });

  it('returns a fully shaped pair when nothing is configured', () => {
    const empty = {
      name: '',
      glottocode: '',
      iso639P3: '',
      tag: '',
      latitude: null,
      longitude: null,
    };
    expect(readLanguages({})).toEqual({ object: empty, meta: empty });
    expect(readLanguages(undefined)).toEqual({ object: empty, meta: empty });
  });

  it('nulls a coordinate that is not a finite number', () => {
    const config = { igt: { languages: { object: { latitude: 'north', longitude: '' } } } };
    expect(readLanguages(config).object).toMatchObject({ latitude: null, longitude: null });
  });
});

describe('hasLanguageIdentity', () => {
  it('is true when any identifying field is filled in', () => {
    expect(hasLanguageIdentity({ name: 'Lezgian' })).toBe(true);
    expect(hasLanguageIdentity({ glottocode: 'lezg1247' })).toBe(true);
    expect(hasLanguageIdentity({ iso639P3: 'lez' })).toBe(true);
  });
  it('is false for an empty language, coordinates alone included', () => {
    expect(hasLanguageIdentity({})).toBe(false);
    expect(hasLanguageIdentity(null)).toBe(false);
    expect(hasLanguageIdentity({ latitude: 41.5 })).toBe(false);
  });
});
