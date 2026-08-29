// Render sentence text with <mark>s over the hit ranges (code-point offsets,
// already sentence-relative and sorted). Shared by the Search and Bulk Edit
// tabs.
export const MarkedText = ({ text, marks }) => {
  if (!marks?.length) return <>{text}</>;
  const chars = [...text];
  const out = [];
  let pos = 0;
  marks.forEach((m, i) => {
    const b = Math.max(pos, Math.min(m.begin, chars.length));
    const e = Math.max(b, Math.min(m.end, chars.length));
    if (b > pos) out.push(chars.slice(pos, b).join(''));
    out.push(
      <mark key={i} className="rounded bg-yellow-200 px-0.5">
        {chars.slice(b, e).join('')}
      </mark>,
    );
    pos = e;
  });
  if (pos < chars.length) out.push(chars.slice(pos).join(''));
  return <>{out}</>;
};
