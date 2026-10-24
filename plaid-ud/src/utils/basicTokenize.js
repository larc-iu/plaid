// Unicode-aware tokenizer using the built-in `Intl.Segmenter` (UAX #29 word
// segmentation). Returns `[begin, end]` ranges in Unicode CODE POINTS (Plaid's
// canonical token-offset unit), skipping whitespace segments. `Intl.Segmenter`
// reports `segment.index`/`segment.length` in UTF-16 code units, so we instead
// track a running code-point cursor over the (contiguous) segments.
//
// Behavior (per UAX #29):
// - Letters / digits form words.
// - Apostrophes in contractions stay (`there'll`, `won't've` → one token).
// - Decimal points and thousands-separators in numbers stay (`3.14`,
//   `100,000` → one token each).
// - Periods between letters in abbreviations stay (`U.S.A` → one token; the
//   trailing sentence-end period splits).
// - Hyphens, slashes, and most other punctuation are SEPARATORS — `co-op`
//   becomes three tokens. If we want UD-style merging back in, it goes as a
//   post-pass.
//
// Locale defaults to `'und'`. When per-document language is tracked, thread
// it through here for better script-specific segmentation (especially for
// ja/zh/th which V8 segments with dictionary lookup when given the locale).
import { cpLength, utf16ToCp } from '@larc-iu/plaid-client';
import {
  isTokenIgnored,
  isWordSpace,
  shouldTokenizeCharacter,
} from '../../../plaid-ui/src/domain/igtWordBreaks.js';

// One segmenter per locale: building one is the costly part, and a gap fill
// asks for one per stretch of untokenized text.
const segmenters = new Map();
const segmenterFor = (locale) => {
  let segmenter = segmenters.get(locale);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
    segmenters.set(locale, segmenter);
  }
  return segmenter;
};

export function basicTokenize(text, locale = 'und') {
  const ranges = [];
  let cp = 0; // running code-point offset (segments tile the text in order)
  for (const { segment } of segmenterFor(locale).segment(text)) {
    const cps = Array.from(segment);
    // Skip pure-whitespace segments; everything else (word-like OR
    // punctuation/symbol) becomes its own token. A segment can hold
    // whitespace at an edge (a soft hyphen joins the space before it under
    // UAX #29), and a token never does.
    let b = 0;
    let e = cps.length;
    while (b < e && isWordSpace(cps[b])) b += 1;
    while (e > b && isWordSpace(cps[e - 1])) e -= 1;
    if (e > b) ranges.push([cp + b, cp + e]);
    cp += cps.length;
  }
  return ranges;
}

/**
 * The document's sentences, as a gap-free partition of [0, len) in code points.
 *
 * A run of line breaks (`\n` or `\r\n`) ends a sentence and is kept with the
 * sentence it follows, so the ranges tile the whole text (the sentence layer is
 * partitioning, and a
 * gap in it is not a thing the server will accept). A text with no newline in
 * it is one sentence, and so is an empty one.
 *
 * The regex matches in UTF-16, so each boundary is converted to a code-point
 * offset: token ranges are code points everywhere in Plaid.
 *
 * @param {string} text the document body
 * @returns {[number, number][]} sentence ranges in document order
 */
export function newlineSentenceRanges(text) {
  const len = cpLength(text);
  const ranges = [];
  let start = 0;
  const newlineRun = /(\r?\n)+/g;
  let m;
  while ((m = newlineRun.exec(text)) !== null) {
    const endCp = utf16ToCp(text, m.index + m[0].length);
    ranges.push([start, endCp]);
    start = endCp;
  }
  if (start < len) ranges.push([start, len]);
  if (ranges.length === 0) ranges.push([0, len]);
  return ranges;
}

/**
 * The tokens Tokenize adds to a text that already has some: `basicTokenize`
 * over each stretch no token covers, cut at the sentence breaks, so a new
 * token sits inside one sentence and beside the tokens there are. This is
 * how a text tokenized in another app gets its punctuation, which that app
 * leaves untokenized (ruling 28 and 29, 2026-10-16). With no tokens it is
 * `basicTokenize` of the whole text, cut at `sentenceRanges`.
 *
 * Where the word layer has an ignored-tokens rule (`config.plaid.ignoredTokens`),
 * the new tokens are exactly what IGT reads the stretch as: each of its words
 * as IGT's tokenizer cuts it (`can't`, `3.14` and `10,000` in pieces where
 * IGT breaks at `'`, `.` and `,`), and a token for each run of what is left
 * that IGT ignores, split as Unicode segmentation splits it (`...` is three).
 * A character IGT breaks a word at but does not ignore (`‼`, a soft hyphen)
 * stays text, since a token of it would be a word to IGT. So IGT reads a text
 * whose gaps this filled as it reads the same text untokenized (ruling 29,
 * REV7-IGT-2, REV7-APPS-2). A project of plaid-ud alone tokenizes as it
 * always has. No token begins or ends with whitespace.
 *
 * @param {string} text the document body
 * @param {[number, number][]} sentenceRanges in code points, in order
 * @param {{begin: number, end: number}[]} tokens the tokens there are
 * @param {string} locale
 * @param {object|null} ignoredTokens the word layer's `config.plaid.ignoredTokens`
 * @returns {[number, number][]} the new tokens' ranges in document order
 */
export function gapTokenize(text, sentenceRanges, tokens, locale = 'und', ignoredTokens = null) {
  const taken = [...tokens].sort((a, b) => a.begin - b.begin);
  const cps = Array.from(text);
  const out = [];
  const fill = (begin, end) => {
    // Most gaps are the space between two words: nothing to segment there.
    let i = begin;
    while (i < end && isWordSpace(cps[i])) i += 1;
    if (i >= end) return;
    const ranges = basicTokenize(cps.slice(begin, end).join(''), locale).map(([b, e]) => [
      begin + b,
      begin + e,
    ]);
    out.push(...(ignoredTokens ? asIgtReads(cps, begin, end, ranges, ignoredTokens) : ranges));
  };
  // Sentences in order, and a cursor over the tokens, which are in order too:
  // each token is looked at for the sentences it reaches, not for every one.
  let first = 0;
  for (const [sBegin, sEnd] of [...sentenceRanges].sort((a, b) => a[0] - b[0])) {
    while (first < taken.length && taken[first].end <= sBegin) first += 1;
    let at = sBegin;
    for (let k = first; k < taken.length && taken[k].begin < sEnd; k += 1) {
      const t = taken[k];
      if (t.end <= at) continue;
      fill(at, Math.min(t.begin, sEnd));
      at = Math.max(at, t.end);
    }
    fill(at, sEnd);
  }
  return out;
}

// The words IGT's tokenizer makes of cps[begin, end): runs of characters that
// are neither whitespace nor a break under the project's config.
function igtWords(cps, begin, end, ignoredTokens) {
  const words = [];
  let start = null;
  for (let i = begin; i <= end; i += 1) {
    const breaks =
      i === end || isWordSpace(cps[i]) || shouldTokenizeCharacter(cps[i], ignoredTokens);
    if (breaks) {
      if (start !== null) words.push([start, i]);
      start = null;
    } else if (start === null) start = i;
  }
  return words;
}

// What IGT reads cps[begin, end) as, as tokens: its words, and each run of
// the rest within one of `ranges` (Unicode segmentation's pieces) that IGT
// ignores, cut at whitespace. A run IGT would read as a word whole is split
// into its characters, and only those IGT ignores become tokens. In order.
function asIgtReads(cps, begin, end, ranges, ignoredTokens) {
  const words = igtWords(cps, begin, end, ignoredTokens);
  const inWord = new Uint8Array(end - begin);
  for (const [b, e] of words) inWord.fill(1, b - begin, e - begin);
  const out = [...words];
  const ignored = (b, e) => isTokenIgnored(cps.slice(b, e).join(''), ignoredTokens);
  for (const [b, e] of ranges) {
    let i = b;
    while (i < e) {
      if (inWord[i - begin] || isWordSpace(cps[i])) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < e && !inWord[j - begin] && !isWordSpace(cps[j])) j += 1;
      if (ignored(i, j)) out.push([i, j]);
      else for (let k = i; k < j; k += 1) if (ignored(k, k + 1)) out.push([k, k + 1]);
      i = j;
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}
