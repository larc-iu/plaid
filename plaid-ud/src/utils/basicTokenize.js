// Unicode-aware tokenizer using the built-in `Intl.Segmenter` (UAX #29 word
// segmentation). Returns `[begin, end]` character ranges in JS string-index
// coordinates, skipping whitespace segments.
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
export function basicTokenize(text, locale = 'und') {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
  const ranges = [];
  for (const { segment, index } of segmenter.segment(text)) {
    // Skip pure-whitespace segments; everything else (word-like OR
    // punctuation/symbol) becomes its own token.
    if (/\S/.test(segment)) {
      ranges.push([index, index + segment.length]);
    }
  }
  return ranges;
}
