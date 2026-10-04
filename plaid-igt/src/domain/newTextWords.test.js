// "Tokenize new text": the words a Baseline save adds, measured on the body
// the save makes, kept off every position an existing word may end up over.
import { describe, expect, it } from 'vitest';
import { cpSlice } from '@larc-iu/plaid-client';
import { isSpaceless, newTextWords } from './newTextWords.js';

const PUNCT = { type: 'unicodePunctuation', whitelist: [] };

// The new words of typing `value` at `at` (or over [at, end)) in `base`, as
// their text on the new body.
function typed(base, at, value, { end = at, words = [], sentences, ignored = PUNCT } = {}) {
  const gaps = [{ start: at, end, value }];
  const out = newTextWords({
    base,
    gaps,
    words,
    sentences: sentences === undefined ? [{ begin: 0, end: [...base].length }] : sentences,
    ignored,
  });
  const chars = [...base];
  const body = [...chars.slice(0, at), ...value, ...chars.slice(end)].join('');
  return out.map((w) => cpSlice(body, w.begin, w.end));
}

// Words over each whitespace-separated run of `text`.
const wordsOf = (text) => {
  const out = [];
  const re = /\S+/gu;
  let m;
  while ((m = re.exec(text))) {
    const begin = [...text.slice(0, m.index)].length;
    out.push({ begin, end: begin + [...m[0]].length });
  }
  return out;
};

describe('newTextWords', () => {
  it('splits a new sentence typed with spaces into words, leaving punctuation out', () => {
    const base = 'the cat.';
    expect(typed(base, 8, '\nA dog ran, fast.', { words: wordsOf('the cat') })).toEqual([
      'A',
      'dog',
      'ran',
      'fast',
    ]);
  });

  it('makes no word of text typed against a word, which the word takes', () => {
    const base = 'the cat sat';
    const words = wordsOf(base);
    expect(typed(base, 7, 's', { words })).toEqual([]);
    expect(typed(base, 4, 'x', { words })).toEqual([]);
    expect(typed(base, 2, 'XYZ', { words })).toEqual([]);
    // the letters up to the first whitespace go to the word, the rest is new
    expect(typed(base, 7, 's big', { words })).toEqual(['big']);
    expect(typed(base, 8, 'big s', { words })).toEqual(['big']);
  });

  it('makes a word of text typed between words with whitespace on both sides', () => {
    const base = 'the cat sat';
    expect(typed(base, 7, ' big', { words: wordsOf(base) })).toEqual(['big']);
    expect(typed(base, 8, 'big ', { words: wordsOf(base) })).toEqual(['big']);
  });

  it('leaves every letter of a gap that reaches inside a word to the server', () => {
    const base = 'the cat sat';
    const words = wordsOf(base);
    // a space typed inside a word is inside it
    expect(typed(base, 5, ' big ', { words })).toEqual([]);
    // a selection over two words typed over
    expect(typed(base, 4, 'one two three', { end: 11, words })).toEqual([]);
  });

  it('makes a word of a gap that types over punctuation and whitespace only', () => {
    const base = 'cat. dog';
    // the comma goes to `cat`, which the gap stands right after
    expect(typed(base, 3, ', big ', { end: 5, words: wordsOf('cat  dog') })).toEqual(['big']);
    expect(
      typed(base, 4, ' big ', { end: 5, words: [wordsOf(base)[0], { begin: 5, end: 8 }] }),
    ).toEqual(['big']);
  });

  it('takes an untokenized stretch the typing touches whole', () => {
    // `dog` has no word: a letter typed after it makes `dogs`
    const base = 'the dog';
    expect(typed(base, 7, 's', { words: [{ begin: 0, end: 3 }] })).toEqual(['dogs']);
    // a stretch the save does not type in stays as it is
    expect(typed(base, 0, 'a ', { words: [] })).toEqual(['a']);
  });

  it('makes nothing of a stretch of ignored characters', () => {
    const base = 'cat';
    expect(typed(base, 3, ' → !', { words: wordsOf(base) })).toEqual([]);
  });

  it('reads the letter-like characters of the ignored-tokens rule', () => {
    const base = 'x';
    const ignored = { type: 'unicodePunctuation', whitelist: ["'"] };
    expect(typed(base, 1, " k'a b-c", { words: wordsOf(base), ignored })).toEqual([
      "k'a",
      'b',
      'c',
    ]);
  });

  it('never tokenizes a sentence without spaces', () => {
    const base = '我今天去北京。';
    expect(typed(base, 7, '\n他明天来，我们走。', { sentences: [{ begin: 0, end: 7 }] })).toEqual(
      [],
    );
    // a new line is a sentence of its own when the save makes the sentences
    expect(
      newTextWords({
        base: '',
        gaps: [{ start: 0, end: 0, value: '我今天去北京。\nI went home.' }],
        words: [],
        sentences: null,
        ignored: PUNCT,
      }),
    ).toEqual([
      { begin: 8, end: 9 },
      { begin: 10, end: 14 },
      { begin: 15, end: 19 },
    ]);
  });

  it('reads a pasted paragraph of spaceless lines in one sentence as spaceless', () => {
    expect(isSpaceless('我今天去北京。\n他明天来。\n')).toBe(true);
    expect(isSpaceless('I went home.\n')).toBe(false);
    expect(isSpaceless('Hello.\n')).toBe(true);
    expect(isSpaceless('123 .')).toBe(false);
    expect(isSpaceless('...')).toBe(false);
  });

  it('measures in code points', () => {
    const base = '𝔞𝔟 cat';
    expect(typed(base, 6, ' 𝔠𝔡 e', { words: wordsOf(base) })).toEqual(['𝔠𝔡', 'e']);
  });

  it('places words on the new body across several gaps', () => {
    const base = 'aa bb cc';
    const words = wordsOf(base);
    const out = newTextWords({
      base,
      gaps: [
        { start: 2, end: 2, value: ' x' },
        { start: 5, end: 6, value: ' yy ' },
      ],
      words,
      sentences: [{ begin: 0, end: 8 }],
      ignored: PUNCT,
    });
    const body = 'aa x bb yy cc';
    expect(out.map((w) => body.slice(w.begin, w.end))).toEqual(['x', 'yy']);
  });

  it('gives nothing for a save that only deletes', () => {
    expect(typed('the cat', 3, '', { end: 7, words: wordsOf('the cat') })).toEqual([]);
  });
});
