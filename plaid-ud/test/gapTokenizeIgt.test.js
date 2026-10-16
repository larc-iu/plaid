// Ruling 29 (2026-10-16), with Luke's rule that IGT must not behave
// differently because UD annotation started: in a project IGT has set up,
// Tokenize on a text that has words adds exactly what IGT reads the
// untokenized stretches as. Oracle over generated texts, under the
// letter-like rule and an explicit list: together with the tokens there
// were, the tokens IGT does not ignore are IGT's own words, one for one
// (REV7-APPS-2), every token it adds that is not one of them is one IGT
// ignores (REV7-IGT-2), none begins or ends with whitespace, none crosses a
// sentence or overlaps a token there was, and every character IGT ignores is
// in a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapTokenize } from '../src/utils/basicTokenize.js';
import {
  isTokenIgnored,
  shouldTokenizeCharacter,
} from '../../plaid-ui/src/domain/igtWordBreaks.js';

const LETTER_LIKE = { type: 'unicodePunctuation', whitelist: ["'", 'ʼ'], blacklist: [] };
const EXPLICIT = { type: 'blacklist', whitelist: [], blacklist: ['.', ',', '?', '...'] };
const ALPHABET = [
  'a',
  'b',
  'k',
  'é',
  '1',
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
  '·',
  // Break a word in IGT but are no punctuation it ignores (REV7-IGT-2).
  '\u00a9',
  '\u00ad',
  '\u00ae',
  '\u203c',
  '\u2049',
  '\u3030',
  '\u303d',
  ' ',
  ' ',
  ' ',
  '\t',
];

// A small seeded generator, so a failure names a case that can be run again.
const rng = (seed) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

// IGT's words over [begin, end): runs of neither whitespace nor a break.
const igtWords = (cps, begin, end, cfg) => {
  const words = [];
  let start = null;
  for (let i = begin; i <= end; i += 1) {
    const breaks = i === end || /\s/.test(cps[i]) || shouldTokenizeCharacter(cps[i], cfg);
    if (breaks) {
      if (start !== null) words.push([start, i]);
      start = null;
    } else if (start === null) start = i;
  }
  return words;
};

for (const [name, cfg] of [
  ['the letter-like rule', LETTER_LIKE],
  ['an explicit list', EXPLICIT],
]) {
  test(`Tokenize adds what IGT reads the text as, on 3,000 generated texts, under ${name}`, () => {
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
      const words = sentences.flatMap(([b, e]) => igtWords(cps, b, e, cfg));
      const existing = words.filter(() => next() < 0.5).map(([begin, end]) => ({ begin, end }));
      const added = gapTokenize(text, sentences, existing, 'und', cfg);
      const say = JSON.stringify(text);
      const content = ([b, e]) => cps.slice(b, e).join('');

      for (const [b, e] of added) {
        assert.ok(e > b, `${say}: empty token`);
        assert.ok(!/\s/.test(cps[b]) && !/\s/.test(cps[e - 1]), `${say}: [${b}, ${e}) whitespace`);
        assert.ok(
          sentences.some(([sb, se]) => sb <= b && e <= se),
          `${say}: [${b}, ${e}) crosses a sentence`,
        );
        assert.ok(!existing.some((t) => t.begin < e && b < t.end), `${say}: overlaps a token`);
        assert.ok(
          words.some(([wb, we]) => wb === b && we === e) || isTokenIgnored(content([b, e]), cfg),
          `${say}: [${b}, ${e}) ${JSON.stringify(content([b, e]))} is a word IGT would not make`,
        );
      }
      const all = [...existing.map((t) => [t.begin, t.end]), ...added].sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < all.length; i += 1) {
        assert.ok(all[i][0] >= all[i - 1][1], `${say}: tokens overlap`);
      }
      // IGT shows the same words as for the text it tokenized itself.
      const shown = all.filter((t) => !isTokenIgnored(content(t), cfg));
      const own = words.filter((w) => !isTokenIgnored(content(w), cfg));
      assert.deepEqual(shown, own, `${say}: IGT's words differ`);
      // Every character IGT ignores lies in some token.
      cps.forEach((c, i) => {
        if (/\s/.test(c) || !isTokenIgnored(c, cfg)) return;
        assert.ok(
          all.some(([b, e]) => b <= i && i < e),
          `${say}: ${JSON.stringify(c)} at ${i} left out`,
        );
      });
      checked += added.length;
    }
    assert.ok(checked > 1000);
  });
}

test('the shapes the rule is for', () => {
  // A letter-like character stays in its word, and an arrow IGT does not
  // break at keeps a→b one token.
  assert.deepEqual(gapTokenize("k' a→b .", [[0, 8]], [], 'und', LETTER_LIKE), [
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

test('words are cut where IGT cuts them, and a run of punctuation as Unicode cuts it (REV7-APPS-2)', () => {
  const cfg = { type: 'unicodePunctuation', whitelist: [], blacklist: [] };
  const words = (text) =>
    gapTokenize(text, [[0, Array.from(text).length]], [], 'und', cfg).map(([b, e]) =>
      Array.from(text).slice(b, e).join(''),
    );
  assert.deepEqual(words("I can't pay 3.14 to the U.S.A today..."), [
    'I',
    'can',
    "'",
    't',
    'pay',
    '3',
    '.',
    '14',
    'to',
    'the',
    'U',
    '.',
    'S',
    '.',
    'A',
    'today',
    '.',
    '.',
    '.',
  ]);
  assert.deepEqual(words('l·l co-op 10,000'), ['l', '·', 'l', 'co', '-', 'op', '10', ',', '000']);
  // In a project of plaid-ud alone, Unicode's words.
  assert.deepEqual(gapTokenize("can't 3.14", [[0, 10]], [], 'und', null).length, 2);
});

test('a character IGT breaks at but reads as a word stays text, and no token begins with a space (REV7-IGT-2)', () => {
  const cfg = { type: 'unicodePunctuation', whitelist: [], blacklist: [] };
  const text = 'ab \u00ad cd\u203c ~\u00ad';
  const got = gapTokenize(text, [[0, Array.from(text).length]], [], 'und', cfg).map(([b, e]) =>
    Array.from(text).slice(b, e).join(''),
  );
  assert.deepEqual(got, ['ab', 'cd', '~']);
});
