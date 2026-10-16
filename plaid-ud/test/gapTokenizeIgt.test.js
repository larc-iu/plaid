// Ruling 29 (2026-10-16), with Luke's rule that IGT must not behave
// differently because UD annotation started: Tokenize on a text that has
// words adds a token only where IGT's own tokenizer leaves a run out of a
// word. Oracle over generated texts: no token it adds has an edge inside a
// word IGT would make (so none splits one, and none takes a letter-like
// character out of its word), and together with the tokens there were, the
// new ones cover every letter of the text, inside one sentence each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapTokenize } from '../src/utils/basicTokenize.js';
import { shouldTokenizeCharacter } from '../../plaid-ui/src/domain/igtWordBreaks.js';

const CFG = { type: 'unicodePunctuation', whitelist: ["'", 'ʼ'] };
const ALPHABET = [
  'a',
  'b',
  'k',
  'é',
  "'",
  'ʼ',
  '.',
  ',',
  '?',
  '!',
  '-',
  '"',
  '→',
  '=',
  '…',
  ' ',
  ' ',
  ' ',
];

// A small seeded generator, so a failure names a case that can be run again.
const rng = (seed) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

// IGT's words over [begin, end): runs of neither whitespace nor a break.
const igtWords = (cps, begin, end) => {
  const words = [];
  let start = null;
  for (let i = begin; i <= end; i += 1) {
    const breaks = i === end || /\s/.test(cps[i]) || shouldTokenizeCharacter(cps[i], CFG);
    if (breaks) {
      if (start !== null) words.push([start, i]);
      start = null;
    } else if (start === null) start = i;
  }
  return words;
};

test('a token Tokenize adds never cuts a word IGT would make, on 3,000 generated texts', () => {
  const next = rng(29);
  let checked = 0;
  for (let n = 0; n < 3000; n += 1) {
    const length = 4 + Math.floor(next() * 30);
    const cps = Array.from({ length }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]);
    const text = cps.join('');
    // Sentences cut at a few random places.
    const cuts = [...new Set(Array.from({ length: 2 }, () => Math.floor(next() * length)))]
      .filter((c) => c > 0 && c < length)
      .sort((a, b) => a - b);
    const sentences = [0, ...cuts].map((b, i) => [b, [...cuts, length][i]]);
    // The words IGT made in some of the text, as an IGT-tokenized text has.
    const words = sentences.flatMap(([b, e]) => igtWords(cps, b, e));
    const existing = words.filter(() => next() < 0.5).map(([begin, end]) => ({ begin, end }));
    const added = gapTokenize(text, sentences, existing, 'und', CFG);

    for (const [b, e] of added) {
      assert.ok(e > b, `empty token in ${JSON.stringify(text)}`);
      for (const [ws, we] of words) {
        assert.ok(
          !(ws < b && b < we) && !(ws < e && e < we),
          `${JSON.stringify(text)}: [${b}, ${e}) cuts [${ws}, ${we})`,
        );
      }
      assert.ok(
        sentences.some(([sb, se]) => sb <= b && e <= se),
        `${JSON.stringify(text)}: [${b}, ${e}) crosses a sentence`,
      );
      assert.ok(!existing.some((t) => t.begin < e && b < t.end), 'overlaps a token there was');
    }
    // Every letter-like or other non-space character lies in some token.
    const all = [...existing.map((t) => [t.begin, t.end]), ...added];
    cps.forEach((c, i) => {
      if (/\s/.test(c)) return;
      assert.ok(
        all.some(([b, e]) => b <= i && i < e),
        `${JSON.stringify(text)}: ${i} left out`,
      );
    });
    checked += added.length;
  }
  assert.ok(checked > 1000);
});

test('the shapes the rule is for', () => {
  // A letter-like character stays in its word, and an arrow IGT does not
  // break at keeps a→b one token.
  assert.deepEqual(gapTokenize("k' a→b .", [[0, 8]], [], 'und', CFG), [
    [0, 2],
    [3, 6],
    [7, 8],
  ]);
  // Without IGT's config on the layer, plaid-ud tokenizes as it always has.
  assert.deepEqual(gapTokenize('a→b', [[0, 3]], [], 'und', null), [
    [0, 1],
    [1, 2],
    [2, 3],
  ]);
});
