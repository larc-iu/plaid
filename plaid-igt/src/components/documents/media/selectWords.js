// Snap a selection made in a box of text to whole words: whitespace at either
// end is dropped first (a drag that started on the space before a word must
// not take the word before that), then a selection that starts or ends inside
// a word grows to the whole word. Offsets are UTF-16 indices as a textarea
// reports them. Returns `{ start, end }`, or null when nothing but whitespace
// was selected.
const isSpace = (ch) => /\s/.test(ch);

export function snapToWords(text, start, end) {
  let a = Math.max(0, Math.min(start, end));
  let b = Math.min(text.length, Math.max(start, end));
  while (a < b && isSpace(text[a])) a++;
  while (b > a && isSpace(text[b - 1])) b--;
  if (a >= b) return null;
  while (a > 0 && !isSpace(text[a - 1])) a--;
  while (b < text.length && !isSpace(text[b])) b++;
  return { start: a, end: b };
}
