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
import { readRepoFile } from '../test/builtinHash.js';
import { newTextLayout, newTextWords } from './newTextWords.js';

const { cases } = JSON.parse(
  readRepoFile('plaid-core/src/test/plaid/algos/sentence_cut_cases.json'),
);
const span = ([begin, end]) => ({ begin, end });
const isSpace = (c) => /\s/u.test(c);
const sentenceOf = (cuts, x) => cuts.filter((b) => b <= x).length;

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
});
