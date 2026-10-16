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
import { shouldTokenizeCharacter } from '../../../plaid-ui/src/domain/igtWordBreaks.js';

export function basicTokenize(text, locale = 'und') {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
  const ranges = [];
  let cp = 0; // running code-point offset (segments tile the text in order)
  for (const { segment } of segmenter.segment(text)) {
    const len = cpLength(segment);
    // Skip pure-whitespace segments; everything else (word-like OR
    // punctuation/symbol) becomes its own token.
    if (/\S/.test(segment)) {
      ranges.push([cp, cp + len]);
    }
    cp += len;
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
 * A new token never splits what IGT's own tokenizer would make one word, and
 * so never leaves a character the project calls letter-like (`ignoredTokens`
 * on the word layer) out of its word: tokens that fall in one such word are
 * joined into one, the word's whole extent. That way IGT reads a text whose
 * gaps this filled the same as it would have tokenized them itself. Only
 * where IGT has set the word layer up (`ignoredTokens` is its config there),
 * so a project of plaid-ud alone tokenizes as it always has.
 *
 * @param {string} text the document body
 * @param {[number, number][]} sentenceRanges in code points, in order
 * @param {{begin: number, end: number}[]} tokens the tokens there are
 * @param {string} locale
 * @param {object|null} ignoredTokens the word layer's `config.igt.ignoredTokens`
 * @returns {[number, number][]} the new tokens' ranges in document order
 */
export function gapTokenize(text, sentenceRanges, tokens, locale = 'und', ignoredTokens = null) {
  const taken = [...tokens].sort((a, b) => a.begin - b.begin);
  const cps = Array.from(text);
  const out = [];
  const fill = (begin, end) => {
    if (end <= begin) return;
    const ranges = basicTokenize(cps.slice(begin, end).join(''), locale).map(([b, e]) => [
      begin + b,
      begin + e,
    ]);
    out.push(
      ...(ignoredTokens ? joinedOver(ranges, igtWords(cps, begin, end, ignoredTokens)) : ranges),
    );
  };
  for (const [sBegin, sEnd] of sentenceRanges) {
    let at = sBegin;
    for (const t of taken) {
      if (t.end <= at || t.begin >= sEnd) continue;
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
    const breaks = i === end || /\s/.test(cps[i]) || shouldTokenizeCharacter(cps[i], ignoredTokens);
    if (breaks) {
      if (start !== null) words.push([start, i]);
      start = null;
    } else if (start === null) start = i;
  }
  return words;
}

// `ranges` with every group that overlaps one of `words` joined into one range
// over the group and the word: in order, none overlapping.
function joinedOver(ranges, words) {
  const all = [...ranges, ...words].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const joined = [];
  for (const [b, e] of all) {
    const last = joined[joined.length - 1];
    if (last && b < last[1]) last[1] = Math.max(last[1], e);
    else joined.push([b, e]);
  }
  return joined;
}
