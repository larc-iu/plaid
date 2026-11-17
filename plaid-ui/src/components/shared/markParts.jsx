// The look of a hit in a sentence, shared by MarkedText and any sentence an
// app lays out itself (plaid-igt's concordance stacks a word over its
// segmentation), so a hit reads the same everywhere.

/** The class of a hit's `<mark>`: the one highlight every match shares. */
export const MARK_CLASS = 'rounded-sm bg-highlight px-0.5 text-foreground';

/** The class of the part of a hit that matched: one step stronger, heavier. */
export const INNER_CLASS = 'rounded-[2px] bg-highlight-strong font-semibold';

/**
 * What goes inside a hit's mark: `chars` (code points) from `b` to `e`, with
 * the `inner` ranges clamped to it and set in their own spans. Plain text
 * when there are none.
 */
export const markContent = (chars, b, e, inner) => {
  if (!inner?.length) return chars.slice(b, e).join('');
  const out = [];
  let pos = b;
  inner.forEach((r, i) => {
    const ib = Math.max(pos, Math.min(r.begin, e));
    const ie = Math.max(ib, Math.min(r.end, e));
    if (ie === ib) return;
    if (ib > pos) out.push(chars.slice(pos, ib).join(''));
    out.push(
      <span key={i} className={INNER_CLASS}>
        {chars.slice(ib, ie).join('')}
      </span>,
    );
    pos = ie;
  });
  if (pos < e) out.push(chars.slice(pos, e).join(''));
  return out;
};
