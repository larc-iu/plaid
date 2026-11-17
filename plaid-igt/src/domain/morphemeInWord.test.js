import { describe, it, expect } from 'vitest';
import { morphemeRangeInWord, segmentationParts } from './morphemeInWord.js';

// A morpheme hit in the dictionary's concordance is marked inside its word
// only when the word's morpheme forms, joined in order, spell the written
// word exactly. Otherwise there is no range, and the row shows the
// segmentation instead. The letters are never searched for.

const ACUTE = String.fromCodePoint(0x301);
const HAIR = String.fromCodePoint(0x200a);
const morph = (id, form, extra = {}) => ({ id, ...extra, metadata: { form, ...extra.metadata } });
const word = (content, morphemes) => ({ id: 'w', content, morphemes });

describe('morphemeRangeInWord', () => {
  it('gives the morpheme its code points in the word when the forms spell it', () => {
    const ms = [morph('m1', 'Uku'), morph('m2', 'ngu'), morph('m3', 'ut')];
    const w = word('Ukunguut', ms);
    expect(morphemeRangeInWord(w, ms[0])).toEqual({ begin: 0, end: 3 });
    expect(morphemeRangeInWord(w, ms[1])).toEqual({ begin: 3, end: 6 });
    expect(morphemeRangeInWord(w, ms[2])).toEqual({ begin: 6, end: 8 });
  });

  it('gives each of two hits in one word its own range', () => {
    const ms = [morph('m1', 'pi'), morph('m2', 'ngu'), morph('m3', 'ngu'), morph('m4', 'q')];
    const w = word('pingunguq', ms);
    expect(morphemeRangeInWord(w, ms[1])).toEqual({ begin: 2, end: 5 });
    expect(morphemeRangeInWord(w, ms[2])).toEqual({ begin: 5, end: 8 });
  });

  it('gives none when a form is underlying and differs from what is written', () => {
    const ms = [morph('m1', 'uku'), morph('m2', 'nge'), morph('m3', 'ut')];
    expect(morphemeRangeInWord(word('ukunguut', ms), ms[1])).toBeNull();
  });

  it('never looks for the letters: an affix that also occurs in the stem gets none', () => {
    // "ngu" is in the written word twice, but the forms do not spell it.
    const ms = [morph('m1', 'ngungu'), morph('m2', '-ngu-')];
    expect(morphemeRangeInWord(word('ngungunguq', ms), ms[1])).toBeNull();
  });

  it('gives none to a word with a zero morph, which no written letter spells', () => {
    const ms = [morph('m1', 'kitab'), morph('m2', '∅')];
    expect(morphemeRangeInWord(word('kitab', ms), ms[0])).toBeNull();
    expect(morphemeRangeInWord(word('kitab', ms), ms[1])).toBeNull();
  });

  it('lets a letter differ from the written one in case only', () => {
    const ms = [morph('m1', 'uku'), morph('m2', 'ngu'), morph('m3', 'ut')];
    expect(morphemeRangeInWord(word('Ukunguut', ms), ms[0])).toEqual({ begin: 0, end: 3 });
    expect(morphemeRangeInWord(word('Ukunguut', ms), ms[1])).toEqual({ begin: 3, end: 6 });
    expect(morphemeRangeInWord(word('UKUNGUUT', ms), ms[1])).toEqual({ begin: 3, end: 6 });
  });

  it('counts a letter whose lower case is longer as a mismatch', () => {
    // İ lowers to i and a combining dot: two code points, so not a case pair.
    const ms = [morph('m1', 'i'), morph('m2', 'ki')];
    expect(morphemeRangeInWord(word('İki', ms), ms[1])).toBeNull();
  });

  it('still gives none for different letters, whatever the case', () => {
    const ms = [morph('m1', 'uku'), morph('m2', 'nge'), morph('m3', 'ut')];
    expect(morphemeRangeInWord(word('Ukunguut', ms), ms[1])).toBeNull();
  });
});

describe('morphemeRangeInWord, a joint written in the text', () => {
  it('skips one hyphen written between two morphemes, in neither range', () => {
    const ms = [morph('m1', 'Messiah'), morph('m2', 'ngu'), morph('m3', 'uq')];
    const w = word('Messiah-nguuq', ms);
    expect(morphemeRangeInWord(w, ms[0])).toEqual({ begin: 0, end: 7 });
    expect(morphemeRangeInWord(w, ms[1])).toEqual({ begin: 8, end: 11 });
    expect(morphemeRangeInWord(w, ms[2])).toEqual({ begin: 11, end: 13 });
  });

  it('skips a clitic "=" the same way', () => {
    const ms = [morph('m1', 'Jesus'), morph('m2', 'am', { morphType: 'enclitic' })];
    expect(morphemeRangeInWord(word('Jesus=am', ms), ms[1])).toEqual({ begin: 6, end: 8 });
  });

  it('lets a form that carries the hyphen own it', () => {
    const ms = [morph('m1', '14-'), morph('m2', 'ngu'), morph('m3', 'kaagut')];
    const w = word('14-ngukaagut', ms);
    expect(morphemeRangeInWord(w, ms[0])).toEqual({ begin: 0, end: 3 });
    expect(morphemeRangeInWord(w, ms[1])).toEqual({ begin: 3, end: 6 });
  });

  it('gives none for two joints in a row', () => {
    const ms = [morph('m1', 'Messiah'), morph('m2', 'ngu'), morph('m3', 'uq')];
    expect(morphemeRangeInWord(word('Messiah--nguuq', ms), ms[1])).toBeNull();
  });

  it('gives none for a joint at the start or the end of the word', () => {
    const ms = [morph('m1', 'ngu'), morph('m2', 'uq')];
    expect(morphemeRangeInWord(word('-nguuq', ms), ms[0])).toBeNull();
    expect(morphemeRangeInWord(word('nguuq-', ms), ms[0])).toBeNull();
  });

  it('gives none for a joint inside a form', () => {
    const ms = [morph('m1', 'Messiah'), morph('m2', 'nguuq')];
    expect(morphemeRangeInWord(word('Messiahng-uuq', ms), ms[1])).toBeNull();
  });

  it('takes a case difference and a joint together', () => {
    const ms = [morph('m1', 'messiah'), morph('m2', 'ngu'), morph('m3', 'uq')];
    expect(morphemeRangeInWord(word('Messiah-NGUuq', ms), ms[1])).toEqual({ begin: 8, end: 11 });
  });

  it('skips only "-" and "=", the joints the app draws', () => {
    const ms = [morph('m1', 'Messiah'), morph('m2', 'ngu')];
    expect(
      morphemeRangeInWord(word('Messiah' + String.fromCodePoint(0x2010) + 'ngu', ms), ms[1]),
    ).toBeNull();
    expect(morphemeRangeInWord(word('Messiah ngu', ms), ms[1])).toBeNull();
  });
});

describe('morphemeRangeInWord, more', () => {
  it('reads a clitic like any other morpheme: the joint is not written', () => {
    const ms = [
      morph('m1', 'Jesus'),
      morph('m2', 'am', { morphType: 'enclitic', metadata: { morphType: 'enclitic' } }),
    ];
    expect(morphemeRangeInWord(word('Jesusam', ms), ms[1])).toEqual({ begin: 5, end: 7 });
  });

  it('gives none to a morpheme whose form is empty, and the others theirs', () => {
    const ms = [morph('m1', 'ukungu'), morph('m2', ''), morph('m3', 'ut')];
    const w = word('ukunguut', ms);
    expect(morphemeRangeInWord(w, ms[1])).toBeNull();
    expect(morphemeRangeInWord(w, ms[2])).toEqual({ begin: 6, end: 8 });
  });

  it('takes a morpheme with no form of its own as its word, as the grid shows it', () => {
    const m = { id: 'm1', content: 'nuna', metadata: {} };
    expect(morphemeRangeInWord(word('nuna', [m]), m)).toEqual({ begin: 0, end: 4 });
  });

  it('counts code points, a supplementary-plane letter as one', () => {
    const ms = [morph('m1', '𐌰𐌺'), morph('m2', 'ngu')];
    expect(morphemeRangeInWord(word('𐌰𐌺ngu', ms), ms[1])).toEqual({ begin: 2, end: 5 });
  });

  it('compares composed text: a decomposed form spells its composed letter', () => {
    // é typed as e and a combining acute in the form, stored composed.
    const ms = [morph('m1', 'cafe' + ACUTE), morph('m2', 'ngu')];
    expect(morphemeRangeInWord(word('café' + 'ngu', ms), ms[1])).toEqual({ begin: 4, end: 7 });
  });

  it('keeps a combining mark the text stores as its own code point', () => {
    // A tone mark with no composed form: two code points, both the stem's.
    const ms = [morph('m1', 'ŋ' + ACUTE + 'a'), morph('m2', 'ngu')];
    expect(morphemeRangeInWord(word('ŋ' + ACUTE + 'angu', ms), ms[1])).toEqual({
      begin: 3,
      end: 6,
    });
  });

  it('gives none when a letter composes across the joint', () => {
    // "e" + a suffix that is only an acute: composed, the joint falls inside é.
    const ms = [morph('m1', 'cafe'), morph('m2', ACUTE)];
    expect(morphemeRangeInWord(word('café', ms), ms[1])).toBeNull();
  });

  it('works the same on a right-to-left word, in logical order', () => {
    const ms = [morph('m1', 'ال'), morph('m2', 'كتاب')];
    expect(morphemeRangeInWord(word('الكتاب', ms), ms[1])).toEqual({ begin: 2, end: 6 });
  });

  it('gives none for a morpheme that is not the word’s', () => {
    const ms = [morph('m1', 'nuna')];
    expect(morphemeRangeInWord(word('nuna', ms), morph('mx', 'nuna'))).toBeNull();
  });
});

describe('segmentationParts', () => {
  it('joins the forms as the grid draws them, the hits flagged', () => {
    const ms = [morph('m1', 'uku'), morph('m2', 'nge'), morph('m3', 'ut')];
    expect(segmentationParts(word('Ukunguut', ms), new Set(['m2']))).toEqual([
      { joiner: null, form: 'uku', hit: false },
      { joiner: '-', form: 'nge', hit: true },
      { joiner: '-', form: 'ut', hit: false },
    ]);
  });

  it('draws "=" by a clitic, flush against it', () => {
    const ms = [
      { id: 'm1', morphType: 'stem', metadata: { form: 'Christ' } },
      { id: 'm2', morphType: 'enclitic', metadata: { form: 'am' } },
    ];
    expect(segmentationParts(word('Christ-am', ms), new Set(['m2']))[1]).toEqual({
      joiner: HAIR + '=',
      form: 'am',
      hit: true,
    });
  });

  it('shows a zero morph as the grid does', () => {
    const ms = [morph('m1', 'kitab'), morph('m2', '∅')];
    expect(segmentationParts(word('kitab', ms), new Set(['m2'])).map((p) => p.form)).toEqual([
      'kitab',
      '∅',
    ]);
  });
});
