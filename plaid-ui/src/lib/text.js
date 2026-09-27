// Shortening user text for storage. The server counts a length in code points,
// so a limit here does too, and a cut never falls inside a character a person
// sees as one (an emoji, a letter with its combining marks).

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * `text` cut to at most `max` code points, at a grapheme boundary. A single
 * grapheme longer than `max` is cut by code point instead, so the answer is
 * empty only for empty text.
 */
export function clipText(text, max) {
  const s = String(text ?? '');
  const cps = [...s];
  if (cps.length <= max) return s;
  let out = '';
  let n = 0;
  for (const { segment } of graphemes.segment(s)) {
    const k = [...segment].length;
    if (n + k > max) break;
    out += segment;
    n += k;
  }
  return out || cps.slice(0, max).join('');
}
