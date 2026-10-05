// "Tokenize new text": the words a Baseline save adds, measured on the body
// the save makes, kept off every position an existing word may end up over.
import { describe, expect, it } from 'vitest';
import { cpSlice } from '@larc-iu/plaid-client';
import { isSpaceless, newTextWords } from './newTextWords.js';

const PUNCT = { type: 'unicodePunctuation', whitelist: [] };

// The new words of typing `value` at `at` (or over [at, end)) in `base`, as
// their text on the new body.
function typed(base, at, value, { end = at, words = [], ignored = PUNCT } = {}) {
  const gaps = [{ start: at, end, value }];
  const out = newTextWords({
    base,
    gaps,
    words,
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
  it('never makes a word across a sentence boundary, moved by the edit', () => {
    // REV-R4-TOK F3: `Hello.|World`, a boundary between letters, `x` typed at it.
    const at = (base, gaps, sentences, words = []) =>
      newTextWords({ base, gaps, words, ignored: PUNCT, sentences }).map(({ begin, end }) => [
        begin,
        end,
      ]);
    const two = [
      { begin: 0, end: 6 },
      { begin: 6, end: 11 },
    ];
    // Typed at the boundary: it goes to the sentence before, so `x` alone.
    expect(at('Hello.World', [{ start: 6, end: 6, value: 'x' }], two)).toEqual([[6, 7]]);
    // Without the sentences, the old prediction: one word across it.
    expect(at('Hello.World', [{ start: 6, end: 6, value: 'x' }], [])).toEqual([[6, 12]]);
    // Typed before the boundary, the boundary moves on with it.
    expect(
      at(
        'ab cd',
        [{ start: 1, end: 1, value: 'x' }],
        [
          { begin: 0, end: 1 },
          { begin: 1, end: 5 },
        ],
      ),
    ).toEqual([[0, 2]]);
    // A gap that deletes across a boundary: its typed text gets no word.
    expect(at('Hello.World', [{ start: 5, end: 8, value: 'zz' }], two)).toEqual([]);
  });

  it('reads a selection typed over and a line pasted over as the server does, trimmed of what they share', () => {
    // L1-TEXT-2: the gaps as typed repeat the old text at their ends.
    const line = 'One two three four.';
    const words = wordsOf('One two three four');
    expect(typed(line, 0, 'One two and three four.', { end: line.length, words })).toEqual(['and']);
    expect(typed(line, 4, 'two plus', { end: 7, words })).toEqual(['plus']);
    expect(
      typed('alpha beta gam ma delta.', 0, 'alpha beta extra gam ma delta.', {
        end: 24,
        words: wordsOf('alpha beta gam ma delta'),
      }),
    ).toEqual(['extra']);
    // A gap that changes nothing makes nothing, and one that types inside a
    // word it keeps still leaves the letters to the word.
    expect(typed(line, 4, 'two', { end: 7, words })).toEqual([]);
    expect(typed(line, 4, 'twoo', { end: 7, words })).toEqual([]);
  });

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

  it('never tokenizes a stretch in a script written without spaces', () => {
    const base = '我今天去北京。';
    expect(typed(base, 7, '\n他明天来，我们走。')).toEqual([]);
    expect(typed('', 0, 'ฉันไปบ้าน ສະບາຍດີ ខ្ញុំ これはペンです')).toEqual([]);
    expect(
      newTextWords({
        base: '',
        gaps: [{ start: 0, end: 0, value: '我今天去北京。\nI went home.' }],
        words: [],
        ignored: PUNCT,
      }),
    ).toEqual([
      { begin: 8, end: 9 },
      { begin: 10, end: 14 },
      { begin: 15, end: 19 },
    ]);
  });

  it('gives a one-word line in a spaced script its word', () => {
    expect(typed('uno', 3, '\nYes.\ntres')).toEqual(['Yes', 'tres']);
  });

  it('judges each stretch of a mixed line on its own', () => {
    expect(typed('', 0, '我用 Plaid 写，hello.')).toEqual(['Plaid', 'hello']);
    // one stretch holding Han is left whole
    expect(typed('', 0, '我用Plaid写')).toEqual([]);
  });

  it('reads the script of the letters, not whitespace or punctuation', () => {
    expect(isSpaceless('我今天去北京。')).toBe(true);
    expect(isSpaceless('ペン')).toBe(true);
    expect(isSpaceless('ກິນ')).toBe(true);
    expect(isSpaceless('Hello.')).toBe(false);
    expect(isSpaceless('tres')).toBe(false);
    expect(isSpaceless('。、・')).toBe(false);
    expect(isSpaceless('κόσμος привет مرحبا')).toBe(false);
    expect(isSpaceless('')).toBe(false);
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
      ignored: PUNCT,
    });
    const body = 'aa x bb yy cc';
    expect(out.map((w) => body.slice(w.begin, w.end))).toEqual(['x', 'yy']);
  });

  it('gives nothing for a save that only deletes', () => {
    expect(typed('the cat', 3, '', { end: 7, words: wordsOf('the cat') })).toEqual([]);
  });
});
