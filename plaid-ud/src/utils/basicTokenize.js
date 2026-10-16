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
 * @param {string} text the document body
 * @param {[number, number][]} sentenceRanges in code points, in order
 * @param {{begin: number, end: number}[]} tokens the tokens there are
 * @param {string} locale
 * @returns {[number, number][]} the new tokens' ranges in document order
 */
export function gapTokenize(text, sentenceRanges, tokens, locale = 'und') {
  const taken = [...tokens].sort((a, b) => a.begin - b.begin);
  const cps = Array.from(text);
  const out = [];
  const fill = (begin, end) => {
    if (end <= begin) return;
    for (const [b, e] of basicTokenize(cps.slice(begin, end).join(''), locale)) {
      out.push([begin + b, begin + e]);
    }
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
