// The edit one change of a text box made, as `client.texts.edit` takes it:
// `prev` and `next` are the box's values before and after, `caret` the caret
// after the change (UTF-16, as the DOM gives it). What follows the caret was
// there before, and the change is what lies between the start the two values
// share and the caret. Indices are in code points. Null when nothing changed.
const isHigh = (s, i) => i > 0 && /[\uD800-\uDBFF]/.test(s[i - 1]);

export function boxEdit(prev, next, caret) {
  if (prev === next) return null;
  let keep = next.length - caret;
  if (keep < 0 || keep > prev.length || !prev.endsWith(next.slice(caret))) keep = 0;
  const prevEnd = prev.length - keep;
  const nextEnd = next.length - keep;
  let front = 0;
  const most = Math.min(prevEnd, nextEnd);
  while (front < most && prev[front] === next[front]) front += 1;
  if (isHigh(prev, front)) front -= 1;
  const index = [...prev.slice(0, front)].length;
  const length = [...prev.slice(front, prevEnd)].length;
  const value = next.slice(front, nextEnd);
  if (length === 0) return { type: 'insert', index, value };
  if (value === '') return { type: 'delete', index, value: length };
  return { type: 'replace', index, length, value };
}
