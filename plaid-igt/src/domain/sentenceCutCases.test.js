// "Tokenize new text" reads where core puts a sentence boundary in a save
// without asking it. This holds that reading to core's on plaid-core's shared
// table (plaid-core/src/test/plaid/algos/sentence_cut_cases.json, which
// plaid-core's sentence-cut-cases-test holds core to):
// - where the save only types, every letter it typed that a new word could
//   take lies in the sentence core puts it in;
// - in every save, the twin cuts between two characters a new word could
//   take, one of them typed, exactly where core begins a sentence (where a
//   deleting gap meets a boundary the twin cuts both its ends and makes no
//   word of its text, so a count of cuts there says nothing);
// - no new word crosses a sentence core begins or overlaps a word core
//   places.
// plaid-client-py's test_sentence_cut_cases.py does the same for the Python
// twin.
import { describe, it, expect } from 'vitest';
import { isIgnoredCharacter } from '../../../plaid-ui/src/domain/igtWordBreaks.js';
import { readRepoFile } from '../test/builtinHash.js';
import { newTextLayout, newTextWords } from './newTextWords.js';

const { cases } = JSON.parse(
  readRepoFile('plaid-core/src/test/plaid/algos/sentence_cut_cases.json'),
);
const span = ([begin, end]) => ({ begin, end });
const isSpace = (c) => /\s/u.test(c);
const sentenceOf = (cuts, x) => cuts.filter((b) => b <= x).length;
const isPunctOnly = (cs) =>
  cs.length > 0 && cs.every((c) => isIgnoredCharacter(c, { type: 'unicodePunctuation' }));

describe('the sentence cut of Tokenize new text', () => {
  it('agrees with core on the shared table', () => {
    const problems = [];
    let checked = 0;
    let pairs = 0;
    for (const c of cases) {
      const save = {
        base: c.base,
        gaps: c.gaps,
        words: c.words.map(span),
        sentences: c.sentences.map(span),
      };
      const layout = newTextLayout(save);
      if (!layout) continue;
      const { body, typed, covered, cut } = layout;
      const core = c.core;
      if (body.join('') !== core.body) {
        problems.push({ base: c.base, gaps: c.gaps, body: body.join('') });
        continue;
      }
      const coreCuts = core.sentenceBegins.filter((b) => b > 0);
      const twinCuts = [];
      cut.forEach((v, x) => v && x > 0 && twinCuts.push(x));
      const free = (x) => !covered[x] && !isSpace(body[x]);
      const inserts = c.gaps.every((g) => g.start === g.end);
      for (let x = 0; x < body.length; x++) {
        if (inserts && typed[x] && free(x)) {
          checked += 1;
          if (sentenceOf(twinCuts, x) !== sentenceOf(coreCuts, x)) {
            problems.push({
              base: c.base,
              gaps: c.gaps,
              letter: x,
              core: coreCuts,
              twin: twinCuts,
            });
          }
        }
        if (x > 0 && free(x - 1) && free(x) && (typed[x - 1] || typed[x])) {
          pairs += 1;
          if (twinCuts.includes(x) !== coreCuts.includes(x)) {
            problems.push({
              base: c.base,
              gaps: c.gaps,
              between: x,
              core: coreCuts,
              twin: twinCuts,
            });
          }
        }
      }
      for (const w of newTextWords({ ...save, ignored: null })) {
        if (coreCuts.some((b) => w.begin < b && b < w.end))
          problems.push({ base: c.base, gaps: c.gaps, crosses: w });
        if (core.words.some(([b, e]) => w.begin < e && b < w.end))
          problems.push({ base: c.base, gaps: c.gaps, overlaps: w });
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(400);
    expect(pairs).toBeGreaterThan(300);
  });

  // REV7-IGT-1: a word made only of punctuation (ud's `(` or `.`) takes no
  // text typed against it, so where a save only types into a text holding
  // one, a letter it typed is free for a new word exactly where core leaves
  // it in no word.
  it('leaves a letter typed against a punctuation word free, as core leaves it in no word', () => {
    const problems = [];
    let checked = 0;
    for (const c of cases) {
      if (!c.gaps.every((g) => g.start === g.end)) continue;
      const chars = [...c.base];
      if (!c.words.some(([b, e]) => isPunctOnly(chars.slice(b, e)))) continue;
      const layout = newTextLayout({
        base: c.base,
        gaps: c.gaps,
        words: c.words.map(span),
        sentences: c.sentences.map(span),
      });
      if (!layout) continue;
      const { body, typed, covered } = layout;
      for (let x = 0; x < body.length; x++) {
        if (!typed[x] || isSpace(body[x])) continue;
        checked += 1;
        const inWord = c.core.words.some(([b, e]) => b <= x && x < e);
        if (inWord !== Boolean(covered[x]))
          problems.push({ base: c.base, gaps: c.gaps, x, inWord });
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(500);
  });
});
