import { describe, it, expect } from 'vitest';
import { buildReplacer, MATCH_EMPTY } from './replacer.js';

const run = (find, matchType, replacement, values) => {
  const { apply, error } = buildReplacer(find, matchType, replacement);
  return { error, out: values.map((v) => apply(v)) };
};

describe('buildReplacer', () => {
  it('rewrites a literal match, case-insensitively', () => {
    expect(run('ka', 'contains', 'ga', ['kat', 'KAt', 'imbwa']).out).toEqual(['gat', 'GAt', null]);
  });

  // "any case" finds Kalamang for ka, and respelling it galamang was a
  // capital lost. Typed in small letters, the replacement takes each match's
  // capitals. Typed with a capital in either box, it is written as typed.
  // Any case is Unicode's simple case folding: ı and İ are letters of their
  // own in Turkic orthographies and are not an i (ruled 2026-10-02, REV-W2
  // Q1), while ſ and the Kelvin sign still fold with s and k.
  it('folds case as Unicode does, leaving ı and İ alone', () => {
    expect(run('i', 'contains', 'e', ['kıt', 'İstanbul', 'kit', 'Iris']).out).toEqual([
      null,
      null,
      'ket',
      'Eres',
    ]);
    expect(run('s', 'contains', 'z', ['\u017f']).out).toEqual(['z']);
    expect(run('k', 'contains', 'g', ['\u212a']).out).toEqual(['G']);
  });

  it('keeps the capitals of each match on an any-case match', () => {
    expect(run('ka', 'contains', 'ga', ['Kalamang', 'KALAMANG', 'kalamang', 'kaKa']).out).toEqual([
      'Galamang',
      'GALAMANG',
      'galamang',
      'gaGa',
    ]);
    expect(run('цу', 'contains', 'цы', ['Цуз']).out).toEqual(['Цыз']);
    expect(run('PFV', 'contains', 'pfv', ['sbj:3.PFV', 'Pfv']).out).toEqual(['sbj:3.pfv', 'pfv']);
    expect(run('ka', 'contains', 'Ga', ['kat', 'KAT']).out).toEqual(['Gat', 'GaT']);
    expect(run('ka', 'contains', '', ['Kat']).out).toEqual(['t']);
  });

  it('rewrites only a whole value on an exact match', () => {
    expect(run('draft', 'exact', 'published', ['draft', 'drafted']).out).toEqual([
      'published',
      null,
    ]);
  });

  it('rewrites through a regex, with groups', () => {
    expect(run('([aeiou])h', 'regex', '$1', ['ah', 'oho', 'kt']).out).toEqual(['a', 'oo', null]);
  });

  it('reports a bad regex and then matches nothing', () => {
    const { error, out } = run('([', 'regex', 'x', ['anything']);
    expect(error).toBeTruthy();
    expect(out).toEqual([null]);
  });

  it('says nothing changed when the match rewrites to itself', () => {
    expect(run('kat', 'exact', 'kat', ['kat']).out).toEqual([null]);
  });

  // H10-SCRIPTS-5: the server finds `pʰá` stored decomposed for the pattern
  // typed composed, so Bulk Edit has to rewrite it too, and only where it
  // matched: the rest of the value keeps its spelling.
  it('matches canonically equivalent text and rewrites only the place it matched', () => {
    const nfd = 'p\u02b0a\u0301.PL';
    expect(run('p\u02b0\u00e1', 'contains', 'p\u02b0a\u02e5', [nfd]).out).toEqual([
      'p\u02b0a\u02e5.PL',
    ]);
    expect(run('kat', 'contains', 'cat', ['te\u0301kst kat']).out).toEqual(['te\u0301kst cat']);
    expect(run('\u00e1', 'contains', 'e\u0301', ['a\u0301']).out).toEqual(['e\u0301']);
    expect(run('(p.)\u00e1', 'regex', '$1a', [nfd]).out).toEqual(['p\u02b0a.PL']);
    expect(run('a', 'contains', 'o', ['p\u02b0a\u0301']).out).toEqual([null]);
    expect(run('\u00e9', 'contains', 'E', ['\u{10400}e\u0301']).out).toEqual(['\u{10400}E']);
    expect(run('\uac00', 'contains', '\ub098', ['\u1100\u1161x']).out).toEqual(['\ub098x']);
  });

  it('matches nothing without something to find', () => {
    expect(run('', 'contains', 'published', ['kat', '']).out).toEqual([null, null]);
  });

  // The three search kinds all skip an empty value, which is why filling a
  // blank needs its own kind. This is the behaviour MATCH_EMPTY exists for.
  it('skips an empty value in every search kind', () => {
    expect(run('a', 'contains', 'b', ['', null, undefined]).out).toEqual([null, null, null]);
    expect(run('.*', 'regex', 'published', ['', null]).out).toEqual([null, null]);
  });
});

describe('buildReplacer, filling a blank', () => {
  it('fills only the values that are not there', () => {
    expect(run('', MATCH_EMPTY, 'published', ['', null, undefined, 'draft']).out).toEqual([
      'published',
      'published',
      'published',
      null,
    ]);
  });

  it('ignores whatever is in the find box', () => {
    expect(run('anything at all', MATCH_EMPTY, 'published', ['', 'draft']).out).toEqual([
      'published',
      null,
    ]);
  });

  it('changes nothing when there is no value to set', () => {
    expect(run('', MATCH_EMPTY, '', ['', 'draft']).out).toEqual([null, null]);
    expect(run('', MATCH_EMPTY, undefined, ['']).out).toEqual([null]);
  });

  it('never reports an error', () => {
    expect(run('([', MATCH_EMPTY, 'published', ['']).error).toBeNull();
  });
});

// Search finds the documents on the server (Java) and these rows are planned
// in the browser. Each case here is one where the two dialects disagreed
// before both read the pattern through translatePattern; plaid-ui javaRegex.test.js
// checks the same agreement against Java itself.
describe('buildReplacer, read as the server reads it', () => {
  it('matches Unicode categories', () => {
    expect(run('\\p{L}', 'regex', 'x', ['ñaa', '12']).out).toEqual(['xxx', null]);
    expect(run('\\p{Lu}', 'regex', 'x', ['Ñu']).out).toEqual(['xu']);
  });

  // A word character is a letter, mark, digit or connector in any script
  // (ruled 2026-10-02), so ĭ and ŭ are inside the word, not a boundary.
  it('takes \\w and \\b in any script', () => {
    expect(
      run('\\bko\\b', 'regex', 'KO', ['ko', 'kĭkoⁿtu´', 'ayiⁿdŭko´', 'koko', 'ŭ ko´']).out,
    ).toEqual(['KO', null, null, null, 'ŭ KO´']);
    expect(run('^\\w+$', 'regex', 'x', ['Цвез', 'ЦӀуьд', 'كتاب', 'a b']).out).toEqual([
      'x',
      'x',
      'x',
      null,
    ]);
    expect(run('\\d', 'regex', '#', ['٣ and 3']).out).toEqual(['# and #']);
  });

  it('reads \\h, \\s, . and $ as Java does', () => {
    expect(run('\\h', 'regex', '_', ['a\u00a0b', 'ahb']).out).toEqual(['a_b', null]);
    // Java's Unicode \s, which the server reads (UNICODE_CHARACTER_CLASS).
    expect(run('\\s', 'regex', '_', ['a\u00a0b', 'a\tb', 'a\u200bb']).out).toEqual([
      'a_b',
      'a_b',
      null,
    ]);
    expect(run('a.b', 'regex', '_', ['a\u0085b', 'a-b']).out).toEqual([null, '_']);
    expect(run('a$', 'regex', 'b', ['a\n', 'a']).out).toEqual(['b\n', 'b']);
  });

  it('reads a script and \\w as Java does', () => {
    expect(run('\\p{IsCyrillic}+', 'regex', 'x', ['Цвез', 'abc']).out).toEqual(['x', null]);
    expect(run('^\\w+$', 'regex', 'x', ['می\u200cخواهم', 'Ⅶ', 'a b']).out).toEqual([
      'x',
      'x',
      null,
    ]);
  });

  it('takes (?i) in any case, as an any-case match does', () => {
    expect(run('(?i)ц', 'regex', 'x', ['Цвез']).out).toEqual(['xвез']);
    expect(run('a(?i)b', 'regex', '_', ['aB', 'AB']).out).toEqual(['_', null]);
  });

  it('refuses a pattern the server would read another way, saying what', () => {
    expect(run('[[:alpha:]]', 'regex', 'x', ['a']).error).toBe(
      'Nested [...] is not supported. Write \\[ for a [.',
    );
    expect(run('\\p{InLatin}', 'regex', 'x', ['a']).error).toMatch(/block, which is not supported/);
    expect(run('(a)?\\1', 'regex', 'x', ['a']).error).toMatch(/always matches/);
  });
});
