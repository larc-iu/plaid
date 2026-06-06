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
import { cpLength } from '@larc-iu/plaid-client';

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
