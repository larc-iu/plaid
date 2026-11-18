// Arrow keys in a grid that may run either way.
//
// Two directions are in play in one keystroke and they are not the same one.
//
// The GRID's direction decides which NEIGHBOUR a key means. In an RTL sentence
// the next word is the one further left, so ArrowLeft moves forwards through
// the sentence and ArrowRight moves back.
//
// The CELL's own direction decides where its TEXT edges are, and a cell is on
// `dir="auto"`, so it resolves on its own content. An English gloss standing in
// a column under an Arabic word is an LTR box: its logical end is still on its
// right, and ArrowRight there has to move the caret through "book" before it
// leaves the cell.
//
// Getting only the first of the two right is worse than doing nothing: the key
// that should walk the caret through a value jumps out of it instead.

/**
 * Is this element laid out right to left? Reads the RESOLVED direction, so a
 * field on `dir="auto"` answers for the value it is actually holding.
 *
 * False wherever the question cannot be asked (no layout engine, a detached
 * node), which leaves every caller on its left-to-right path.
 */
export const isRtlBox = (el) => {
  try {
    return globalThis.getComputedStyle?.(el)?.direction === 'rtl';
  } catch {
    return false;
  }
};

/**
 * Is the caret at the edge this arrow key presses TOWARDS, so the key should
 * leave the field rather than move inside it?
 *
 * A collapsed caret only: a selection collapses first, so editing text is never
 * hijacked. An empty field is at both its edges and always qualifies.
 */
export const caretAtArrowEdge = (el, visualRight) => {
  const start = el?.selectionStart ?? 0;
  const end = el?.selectionEnd ?? 0;
  if (start !== end) return false;
  const towardLogicalEnd = isRtlBox(el) ? !visualRight : visualRight;
  return towardLogicalEnd ? end === (el?.value ?? '').length : start === 0;
};

/**
 * Which way along the reading order an arrow key steps, given how the grid
 * around it is laid out: 1 forwards, -1 back.
 */
export const arrowStep = (visualRight, gridRtl) => (visualRight === !!gridRtl ? -1 : 1);

// A value inside a line built as a string: an audit label, a toast. Between
// FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE it keeps its own direction,
// so `Respell “كتاب” → “كتب”` reads in its own order instead of the arrow
// joining two right-to-left values into one run that reads backwards. A line
// drawn from parts puts each value in a `<bdi>` instead.
export const isolate = (value) => `\u2068${value ?? ''}\u2069`;

// A stored label shown in a list (History, Activity, the Restore and Undo
// dialogs), in PARTS: a string is drawn as it is, and `{ isolate: parts }` is
// drawn in a `<bdi>` (components/shared/IsolatedLabel.jsx), so a
// right-to-left value reads in its own order while the text stays the stored
// label, character for character: copied, searched or read by a test it is
// what was stored, with no U+2066 to U+2069 in it (REV-G4-1). A fixed rule:
// - with an arrow, each side of it (`Respell كَتَبَ → كتب` reads old to new),
//   its own quoted runs isolated within it (`Replace “x” → “y” in Gloss`,
//   REV-G4-R2-2: a <bdi> takes its direction from its own text outside any
//   nested one, so “y” does not turn " in Gloss" around);
// - else each quoted run ("…" or “…”), and everything after the first ': '
//   outside quotes, which is a cell edit's value (`Translation of sentence
//   1: ذهب Ahmed إلى`, H2-8-2), its own quoted runs isolated within it.
//   A value may hold a colon of its own.
// A label with none of these is one plain part. Joining the text of every
// part gives the label back (`labelText`).
const QUOTES = { '"': '"', '\u201c': '\u201d' };

const quotedParts = (text) => {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(/"([^"]*)"|\u201c([^\u201d]*)\u201d/g)) {
    const inner = m[1] ?? m[2];
    out.push(text.slice(at, m.index + 1), { isolate: [inner] });
    at = m.index + 1 + inner.length;
  }
  out.push(text.slice(at));
  return out.filter((p) => p !== '');
};

export const labelParts = (label) => {
  if (typeof label !== 'string' || label === '') return label ? [String(label)] : [];
  if (label.includes(' → ')) {
    return label
      .split(' → ')
      .flatMap((side, i) => [...(i ? [' → '] : []), { isolate: quotedParts(side) }]);
  }
  let close = null;
  for (let i = 0; i < label.length; i += 1) {
    const ch = label[i];
    if (close) {
      if (ch === close) close = null;
    } else if (QUOTES[ch]) {
      close = QUOTES[ch];
    } else if (ch === ':' && label[i + 1] === ' ') {
      const value = label.slice(i + 2);
      return [
        ...quotedParts(label.slice(0, i)),
        ': ',
        ...(value ? [{ isolate: quotedParts(value) }] : []),
      ];
    }
  }
  return quotedParts(label);
};

/** The text of `labelParts` joined: the label itself. */
export const labelText = (parts) =>
  parts.map((p) => (typeof p === 'string' ? p : labelText(p.isolate))).join('');
