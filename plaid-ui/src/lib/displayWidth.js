// How many columns a string takes in a monospace font, for an export that
// lines its columns up with spaces. Counted by user-perceived character
// (grapheme cluster): a letter with its combining marks is one column however
// many code points spell it, an East Asian wide character or a Hangul
// syllable (precomposed or written in jamo) is two, and a cluster of nothing
// visible (a zero-width space, a joiner, a control) is none. A reader's font
// may still differ, so this gets the common cases right, not every one.
// Dependency-free, so a module the plain node suites load can import it by
// its real path.

// East Asian Width W and F (Unicode's EastAsianWidth.txt), merged into ranges,
// with every Hangul jamo block counted wide since a cluster of jamo is drawn
// as one syllable.
const WIDE = [
  [0x1100, 0x11ff],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff1],
  [0x17000, 0x18cd5],
  [0x18d00, 0x18d08],
  [0x1aff0, 0x1b2fb],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f2ff],
  [0x1f300, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const isWide = (cp) => {
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (cp < WIDE[mid][0]) hi = mid - 1;
    else if (cp > WIDE[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
};

// A cluster drawn as nothing: controls, format characters (joiners, the
// zero-width space, bidi marks) and marks with no letter to sit on.
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{M}]+$/u;

let segmenter = null;
const clusters = (s) => {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(s), (x) => x.segment);
};

/** The columns `s` takes in a monospace font. */
export function displayWidth(s) {
  const text = String(s ?? '');
  // Printable ASCII, the usual gloss line, is one column a character.
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let width = 0;
  for (const cluster of clusters(text)) {
    if (INVISIBLE.test(cluster)) continue;
    width += isWide(cluster.codePointAt(0)) ? 2 : 1;
  }
  return width;
}

/** `s` with spaces after it to fill `width` columns. */
export const padToWidth = (s, width) =>
  `${s ?? ''}${' '.repeat(Math.max(0, width - displayWidth(s)))}`;
