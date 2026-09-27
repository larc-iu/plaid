import { detectDirection } from '../../domain/textDirection.js';

/**
 * A sentence with its search hits marked, one look in every app (Search, Bulk
 * Edit, Validation, the dictionary's concordance, UD's Grew results).
 *
 * Props:
 * - `text`: the sentence.
 * - `marks`: `[{ begin, end }]`, code-point offsets into `text`, sorted and
 *   not overlapping. Out-of-range offsets are clamped.
 *
 * The excerpt is isolated with its own direction, since it sits in an English
 * row. A sentence's direction is its letters' majority, not its first
 * letter's: an Arabic sentence may open with a Latin name.
 */
export const MarkedText = ({ text, marks }) => {
  const dir = detectDirection(text);
  if (!marks?.length) return <bdi dir={dir}>{text}</bdi>;
  const chars = [...text];
  const out = [];
  let pos = 0;
  marks.forEach((m, i) => {
    const b = Math.max(pos, Math.min(m.begin, chars.length));
    const e = Math.max(b, Math.min(m.end, chars.length));
    if (b > pos) out.push(chars.slice(pos, b).join(''));
    out.push(
      <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 text-foreground">
        {chars.slice(b, e).join('')}
      </mark>,
    );
    pos = e;
  });
  if (pos < chars.length) out.push(chars.slice(pos).join(''));
  return <bdi dir={dir}>{out}</bdi>;
};
