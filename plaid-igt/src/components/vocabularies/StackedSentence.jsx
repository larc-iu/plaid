import { detectDirection } from '@ui/domain/textDirection.js';
import { MARK_CLASS, INNER_CLASS, markContent } from '@ui/components/shared/markParts.jsx';

/**
 * A sentence with its hits marked, as MarkedText draws it, where some hit
 * words carry their segmentation directly beneath them (GH #68): a morpheme
 * hit whose forms do not spell the written word (withMorphemeHits). Each such
 * word and its segmentation are one inline block, as wide as the wider of
 * the two, that wraps as a unit and starts at the word's own start edge in
 * the sentence's direction. The other words take one line.
 *
 * The block is aligned by its top: its first line has the sentence's font and
 * line height, so the word sits on the sentence's baseline. The segmentation
 * is inline after a line break, not a block of its own, and cannot be
 * selected, so a copy of the sentence is its written text with no line breaks
 * (a block or flex item would add one around the word).
 *
 * `stacks`: `[{ begin, end, parts }]`, each the extent of a marked word, in
 * the same code-point offsets as `marks`.
 */
export const StackedSentence = ({ text, marks, stacks }) => {
  const dir = detectDirection(text);
  const stackAt = new Map(stacks.map((st) => [st.begin, st]));
  const chars = [...text];
  const out = [];
  let pos = 0;
  marks.forEach((m, i) => {
    const b = Math.max(pos, Math.min(m.begin, chars.length));
    const e = Math.max(b, Math.min(m.end, chars.length));
    if (b > pos) out.push(chars.slice(pos, b).join(''));
    const mark = (
      <mark key={i} className={MARK_CLASS}>
        {markContent(chars, b, e, m.inner)}
      </mark>
    );
    const stack = stackAt.get(m.begin);
    out.push(
      stack && stack.end === m.end ? (
        <span key={i} data-stack className="inline-block text-start align-top">
          {mark}
          <span className="select-none">
            <br />
          </span>
          <span data-segmentation className="select-none px-0.5 text-xs text-muted-foreground">
            {stack.parts.map((p, j) => (
              <span key={j}>
                {p.joiner}
                {p.hit ? (
                  <span className={`${INNER_CLASS} text-foreground`}>{p.form}</span>
                ) : (
                  p.form
                )}
              </span>
            ))}
          </span>
        </span>
      ) : (
        mark
      ),
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
