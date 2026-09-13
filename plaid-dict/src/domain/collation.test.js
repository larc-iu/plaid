import { describe, it, expect } from 'vitest';
import {
  alphabetCollator,
  formatAlphabet,
  outsideAlphabet,
  parseAlphabet,
  splitGraphemes,
  suggestAlphabet,
} from './collation.js';

// Sena's shape: bv and ch are letters, each after the plain one it starts with.
const sena = parseAlphabet('a b bv c ch d e f g h i j k l m n nh o p r s t u v w y z');

// Yoruba's shape: e/ẹ, o/ọ and s/ṣ are separate letters, and tone marks are not
// letters at all. Nothing here is precomposed with its tone, so `ọ̀` is U+1ECD
// plus U+0300 and every unit below is two code points wearing one.
const yoruba = parseAlphabet('a b d e ẹ f g gb h i j k l m n o ọ p r s ṣ t u w y');

describe('parseAlphabet / formatAlphabet', () => {
  it('reads whitespace-separated units, lowercased and deduped', () => {
    expect(parseAlphabet('  A  b   CH b ')).toEqual(['a', 'b', 'ch']);
    expect(parseAlphabet('')).toEqual([]);
    expect(parseAlphabet(null)).toEqual([]);
  });

  it('round-trips what a person typed', () => {
    expect(formatAlphabet(parseAlphabet('a b ch'))).toBe('a b ch');
    expect(formatAlphabet([])).toBe('');
  });
});

describe('splitGraphemes', () => {
  it('takes the longest unit at each position', () => {
    expect(splitGraphemes('chapa', sena)).toEqual(['ch', 'a', 'p', 'a']);
    expect(splitGraphemes('capa', sena)).toEqual(['c', 'a', 'p', 'a']);
    expect(splitGraphemes('nhanha', sena)).toEqual(['nh', 'a', 'nh', 'a']);
  });

  it('is case-insensitive', () => {
    expect(splitGraphemes('CHAPA', sena)).toEqual(['ch', 'a', 'p', 'a']);
  });

  it('files an accented letter under the base one the alphabet lists', () => {
    expect(splitGraphemes('bárigi', sena)[1]).toBe('a');
  });

  it('prefers the accented unit when the alphabet lists it', () => {
    const withAcute = parseAlphabet('a á b');
    expect(splitGraphemes('áb', withAcute)).toEqual(['á', 'b']);
  });

  it('keeps a combining tone mark with the letter it sits on', () => {
    // Split by code point, the bare U+0300 became its own unit, matched no
    // letter, and ranked above every letter in the alphabet.
    expect(splitGraphemes('ọ̀kọ̀', yoruba)).toEqual(['ọ', 'k', 'ọ']);
    expect(splitGraphemes('ẹ́ja', yoruba)).toEqual(['ẹ', 'j', 'a']);
  });

  it('yields one code point for a character it cannot place', () => {
    expect(splitGraphemes("'ala", sena)).toEqual(["'", 'a', 'l', 'a']);
    expect(splitGraphemes('∅kat', sena)[0]).toBe('∅');
  });

  it('splits every form when no alphabet is given', () => {
    expect(splitGraphemes('kat', [])).toEqual(['k', 'a', 't']);
  });
});

describe('alphabetCollator', () => {
  const { compare, letterOf } = alphabetCollator(sena);
  const sorted = (forms) => [...forms].sort(compare);

  it('puts an n-graph after every plain letter it starts with', () => {
    expect(sorted(['chapa', 'capa', 'cima', 'daka'])).toEqual(['capa', 'cima', 'chapa', 'daka']);
  });

  it('compares beyond the first letter', () => {
    expect(sorted(['bvumbe', 'bala', 'bembe'])).toEqual(['bala', 'bembe', 'bvumbe']);
  });

  it('puts a shorter form before one that extends it', () => {
    expect(sorted(['bala', 'bal', 'balika'])).toEqual(['bal', 'bala', 'balika']);
  });

  it('gathers what it cannot place after every letter, in code-point order', () => {
    expect(sorted(['zuwa', "'ala", 'abwe', '∅kat'])).toEqual(['abwe', 'zuwa', "'ala", '∅kat']);
  });

  it('files a tonal homonym set together, whatever its tones', () => {
    // The four ọkọ words. Split by code point, ọ̀kọ̀ and ọ́kọ́ sorted after owó,
    // away from the set they belong to, and the index showed them under a
    // heading of their own.
    const yb = alphabetCollator(yoruba);
    expect([...['owó', 'ọ̀kọ̀', 'ọkọ', 'ọkọ́', 'ilé']].sort(yb.compare)).toEqual([
      'ilé',
      'owó',
      'ọkọ',
      'ọkọ́',
      'ọ̀kọ̀',
    ]);
    expect(yb.letterOf('ọ̀kọ̀')).toBe('Ọ');
    expect(yb.letterOf('ẹ́ja')).toBe('Ẹ');
  });

  it('heads a bucket with the letter, title-cased, never all caps', () => {
    expect(letterOf('chapa')).toBe('Ch');
    expect(letterOf('capa')).toBe('C');
    expect(letterOf('nhanha')).toBe('Nh');
    expect(letterOf("'ala")).toBe("'");
  });

  it('settles same-letter forms by the text, so case does not tie', () => {
    expect(compare('kat', 'kat')).toBe(0);
    expect(compare('Kat', 'kat')).not.toBe(0);
  });
});

describe('suggestAlphabet', () => {
  it('offers one unit per distinct first grapheme, as written and ordered', () => {
    expect(suggestAlphabet(['zuwa', 'abwe', 'ábwe', 'Kat', 'kat'])).toEqual(['a', 'á', 'k', 'z']);
  });

  it('keeps a marked letter instead of folding it away', () => {
    // Folding proposed `e i j l o p` for this Yoruba set, quietly deleting two
    // of the language's letters. A compiler can delete a suggestion; they
    // cannot easily notice one that was never made.
    expect(suggestAlphabet(['ẹja', 'ilé', 'jẹ', 'lọ', 'omi', 'ọkọ', 'pupa'])).toEqual([
      'e\u0323'.normalize('NFC'),
      'i',
      'j',
      'l',
      'o',
      'o\u0323'.normalize('NFC'),
      'p',
    ]);
  });

  it('keeps a combining mark with its letter rather than proposing the mark', () => {
    expect(suggestAlphabet(['ọ̀kọ̀'])).toEqual(['ọ̀']);
  });

  it('is empty for no forms', () => {
    expect(suggestAlphabet([])).toEqual([]);
  });
});

describe('outsideAlphabet', () => {
  it('names the headwords whose first letter the alphabet misses', () => {
    expect(outsideAlphabet(['kat', "'ala", '∅kat'], sena)).toEqual(["'ala", '∅kat']);
  });

  it('finds none when no alphabet is stated', () => {
    expect(outsideAlphabet(["'ala"], [])).toEqual([]);
  });
});
