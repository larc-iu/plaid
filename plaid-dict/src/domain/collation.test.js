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
  it('offers one unit per distinct first letter, folded and ordered', () => {
    expect(suggestAlphabet(['zuwa', 'abwe', 'ábwe', 'Kat', 'kat'])).toEqual(['a', 'k', 'z']);
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
