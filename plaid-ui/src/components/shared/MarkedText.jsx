import { detectDirection } from '../../domain/textDirection.js';

// The text of a mark from `b` to `e`, its inner stretches clamped to it and
// set in their own spans.
const innerParts = (chars, b, e, inner) => {
  const out = [];
  let pos = b;
  inner.forEach((r, i) => {
    const ib = Math.max(pos, Math.min(r.begin, e));
    const ie = Math.max(ib, Math.min(r.end, e));
    if (ie === ib) return;
    if (ib > pos) out.push(chars.slice(pos, ib).join(''));
    out.push(
      <span key={i} className="rounded-[2px] bg-highlight-strong font-semibold">
        {chars.slice(ib, ie).join('')}
      </span>,
    );
    pos = ie;
  });
  if (pos < e) out.push(chars.slice(pos, e).join(''));
  return out;
};

/**
 * A sentence with its search hits marked, one look in every app (Search, Bulk
 * Edit, Validation, the dictionary's concordance, UD's Grew results).
 *
 * Props:
 * - `text`: the sentence.
 * - `marks`: `[{ begin, end, inner? }]`, code-point offsets into `text`,
 *   sorted and not overlapping. Out-of-range offsets are clamped. `inner`,
 *   optional, is `[{ begin, end }]` in the same offsets, sorted and not
 *   overlapping: the part of the hit that matched (a morpheme in its word),
 *   clamped to the mark.
 *
 * The excerpt is language data, set in Charis, and a hit wears the one
 * highlight every "this matched" mark in the apps shares. An inner stretch is
 * the same highlight one step stronger and heavier, a plain span inside the
 * mark: a screen reader reads the word whole and announces one highlight.
 *
 * The excerpt is isolated with its own direction, since it sits in an English
 * row. A sentence's direction is its letters' majority, not its first
 * letter's: an Arabic sentence may open with a Latin name.
 */
export const MarkedText = ({ text, marks }) => {
  const dir = detectDirection(text);
  if (!marks?.length)
    return (
      <bdi dir={dir} className="font-text">
        {text}
      </bdi>
    );
  const chars = [...text];
  const out = [];
  let pos = 0;
  marks.forEach((m, i) => {
    const b = Math.max(pos, Math.min(m.begin, chars.length));
    const e = Math.max(b, Math.min(m.end, chars.length));
    if (b > pos) out.push(chars.slice(pos, b).join(''));
    out.push(
      <mark key={i} className="rounded-sm bg-highlight px-0.5 text-foreground">
        {m.inner?.length ? innerParts(chars, b, e, m.inner) : chars.slice(b, e).join('')}
      </mark>,
    );
    pos = e;
  });
  if (pos < chars.length) out.push(chars.slice(pos).join(''));
  return (
    <bdi dir={dir} className="font-text">
      {out}
    </bdi>
  );
};
