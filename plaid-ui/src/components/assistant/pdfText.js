// A PDF's text, laid out as a person reads the page, with its pages and
// sections marked so the assistant can find "§9" or "page 41" without reading
// the rest. The composer stores the result as an ordinary text attachment.
//
// This is the browser's half of a pair. The assistant service extracts the
// PDFs it fetches itself with the same layout, cleaning and markers
// (plaid-agent/src/plaid_agent/core/pdftext.py), and its read_file finds pages
// and sections by the markers written here. plaid-agent's
// tests/test_pdf_mirror.py runs both over the same input, so change the two
// together.
//
// The markers are lines of their own:
//
//   === # 9 Complex predicates ===
//   === ## 9.1 Aspect and modality ===
//   === page 184 (PDF page 29) ===
//
// A section marker comes from the PDF's bookmarks and stands before the marker
// of the page the section begins on. A page marker gives the number printed on
// the page where the PDF says what that is, and the PDF's own count beside it
// when the two differ.

// --- the numbers both producers use ----------------------------------------------

const EMPTY_PAGE_CHARS = 20;
const JOIN_GAP = 0.15;
const SPACE_GAP = 0.8;
const RTL_JOIN_GAP = 0.3;
const WORD_GAP = 0.5;
const ALIGNED = 0.15;
const SAME_LINE = 0.5;
const BLANK_LINE = 1.6;
const MAX_SECTIONS = 2000;
const MAX_DEPTH = 6;

// --- cleaning ----------------------------------------------------------------------

// Typographic ligatures spelled out, and nothing else folded: NFKC would also
// turn a superscript ʰ into h, a distinction a transcription makes on purpose.
const LIGATURES = {
  '\ufb00': 'ff',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
  '\ufb05': 'st',
  '\ufb06': 'st',
};

// A spacing accent before its letter, which is how a TeX accent comes out of a
// font with no combining marks, becomes the combining mark after the letter.
const SPACING_ACCENTS = {
  '\u00b4': '\u0301',
  '\u00a8': '\u0308',
  '\u02dc': '\u0303',
  '\u02c6': '\u0302',
  '\u02c7': '\u030c',
  '\u02d8': '\u0306',
  '\u00af': '\u0304',
  '\u02d9': '\u0307',
  '\u02da': '\u030a',
};

const ACCENT_RE = new RegExp(`([${Object.keys(SPACING_ACCENTS).join('')}])(\\p{L})`, 'gu');
// The class is a range of combining marks on purpose: a mark set apart from its
// letter by a space is what is being looked for.
// eslint-disable-next-line no-misleading-character-class
const LOOSE_MARK_RE = /(\S)[ \t]+([\u0300-\u036f\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f])/gu;
const PRESENTATION_RE = /[\ufb50-\ufdff\ufe70-\ufeff]/gu;

export const cleanText = (input) => {
  if (!input) return '';
  let text = input;
  for (const [lig, letters] of Object.entries(LIGATURES)) text = text.split(lig).join(letters);
  text = text.replace(PRESENTATION_RE, (ch) => ch.normalize('NFKC'));
  text = text.replace(ACCENT_RE, (_, accent, letter) => letter + SPACING_ACCENTS[accent]);
  text = text.replace(LOOSE_MARK_RE, '$1$2');
  text = text.normalize('NFC');
  text = text
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .join('\n');
  return text.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
};

// --- direction ---------------------------------------------------------------------

const rtlChar = (ch) => {
  const o = ch.codePointAt(0);
  return (
    (o >= 0x0590 && o <= 0x08ff) || (o >= 0xfb1d && o <= 0xfdff) || (o >= 0xfe70 && o <= 0xfeff)
  );
};

const ltrChar = (ch) => /\p{L}/u.test(ch) && !rtlChar(ch);

const isRtl = (text) => {
  let r = 0;
  let l = 0;
  for (const ch of text) {
    if (rtlChar(ch)) r += 1;
    else if (ltrChar(ch)) l += 1;
  }
  return r > 0 && r >= l;
};

// A right-to-left run in the order it is read, from the order it is drawn in.
// Numbers and Latin inside it keep their own order. Its own inverse.
export const logical = (visual) =>
  (visual.match(/[0-9A-Za-z.,:]+|[^0-9A-Za-z.,:]/gu) || []).reverse().join('');

const len = (s) => [...s].length;

// --- runs and lines ----------------------------------------------------------------

// Runs of text from the pieces a library reports, in drawing order: each
// `{text, x0, x1, y, size}`. See runs_from_items in pdftext.py.
export const runsFromItems = (items) => {
  const runs = [];
  let cur = null;
  let space = false;
  const close = () => {
    if (cur) runs.push({ ...cur, text: isRtl(cur.text) ? logical(cur.text) : cur.text });
  };
  for (const it of items) {
    const rawText = it.text || '';
    const text = rawText.trim();
    if (!text) {
      space = space || cur !== null;
      continue;
    }
    if (/^\s/u.test(rawText) && cur) space = true;
    const size = Number(it.size) || 1;
    const { x0, x1, y } = it;
    const gap = cur ? x0 - cur.x1 : 0;
    const join =
      cur && rtlChar([...cur.text].pop()) && rtlChar([...text][0]) ? RTL_JOIN_GAP : JOIN_GAP;
    if (
      cur &&
      Math.abs(cur.y - y) <= 0.2 * Math.max(cur.size, size) &&
      Math.abs(cur.size - size) <= 0.01 * Math.max(cur.size, size) &&
      gap >= -0.5 * size &&
      (gap < join * size || (space && gap < WORD_GAP * size))
    ) {
      cur.text += (space ? ' ' : '') + text;
      cur.x1 = Math.max(cur.x1, x1);
    } else {
      close();
      cur = { text, x0, x1, y, size };
    }
    space = /\s$/u.test(rawText);
  }
  close();
  return runs;
};

const SMALL_CAPS_RE = /^[\p{Ll}.-]*\p{Ll}[\p{Ll}.-]*$/u;

const smallCaps = (runs) => {
  const out = runs.map((r) => ({ ...r }));
  out.forEach((r, i) => {
    if (!SMALL_CAPS_RE.test(r.text)) return;
    // Smaller than any run of its line on the same baseline, touching it or
    // alone in its column, as pdftext.py reads it.
    if (
      runs.some((n, j) => j !== i && r.size < 0.85 * n.size && Math.abs(r.y - n.y) <= 0.15 * n.size)
    ) {
      r.text = r.text.toUpperCase();
    }
  });
  return out;
};

const ltrLine = (lineRuns, left, cw, beside) => {
  const runs = smallCaps([...lineRuns].sort((a, b) => a.x0 - b.x0));
  let out = '';
  let width = 0;
  let prev = null;
  for (const r of runs) {
    let pad;
    if (!prev) {
      pad = Math.max(0, Math.round((r.x0 - left) / cw));
    } else {
      const gap = r.x0 - prev.x1;
      const size = Math.max(prev.size, r.size);
      const aligned = beside.some((x) => Math.abs(r.x0 - x) <= ALIGNED * size);
      if (gap < JOIN_GAP * size) pad = 0;
      else if (gap < SPACE_GAP * size && !aligned) pad = 1;
      else pad = Math.max(gap >= SPACE_GAP * size ? 2 : 1, Math.round((r.x0 - left) / cw) - width);
    }
    out += ' '.repeat(pad) + r.text;
    width += pad + len(r.text);
    prev = r;
  }
  return out;
};

const rtlLine = (lineRuns) => {
  const runs = [...lineRuns].sort((a, b) => b.x1 - a.x1);
  let out = '';
  let prev = null;
  for (const r of runs) {
    if (prev) {
      const gap = prev.x0 - r.x1;
      const size = Math.max(prev.size, r.size);
      out += gap < JOIN_GAP * size ? '' : gap < SPACE_GAP * size ? ' ' : '  ';
    }
    out += r.text;
    prev = r;
  }
  return out;
};

// One page's text from its runs. See layout in pdftext.py.
export const layoutPage = (input) => {
  const runs = input.filter((r) => (r.text || '').trim());
  if (!runs.length) return '';
  let chars = 0;
  let width = 0;
  for (const r of runs) {
    chars += len(r.text);
    width += Math.max(0, r.x1 - r.x0);
  }
  const cw = chars && width > 0 ? width / chars : 5;
  const left = Math.min(...runs.map((r) => r.x0));
  const lines = [];
  for (const r of [...runs].sort((a, b) => b.y - a.y || a.x0 - b.x0)) {
    const line = lines.length ? lines[lines.length - 1] : null;
    if (line && Math.abs(line.y - r.y) <= SAME_LINE * Math.max(line.size, r.size)) {
      line.runs.push(r);
      line.size = Math.max(line.size, r.size);
    } else {
      lines.push({ y: r.y, size: r.size, runs: [r] });
    }
  }
  lines.forEach((line, k) => {
    line.beside = [k - 1, k + 1]
      .filter((j) => j >= 0 && j < lines.length)
      .flatMap((j) => lines[j].runs.map((r) => r.x0));
  });
  const out = [];
  let prevY = null;
  let prevSize = 0;
  for (const line of lines) {
    if (prevY !== null && prevY - line.y > BLANK_LINE * Math.max(prevSize, line.size)) out.push('');
    prevY = line.y;
    prevSize = line.size;
    const text = line.runs.map((r) => r.text).join('');
    out.push(isRtl(text) ? rtlLine(line.runs) : ltrLine(line.runs, left, cw, line.beside));
  }
  return out.join('\n');
};

// --- the whole document ------------------------------------------------------------

const MARKER_RE = /^=== (?:page (.+?)(?: \(PDF page (\d+)\))?|(#{1,6}) (.*)) ===$/;

const pageMarker = (index, label = '') => {
  const n = index + 1;
  const clean = (label || '').split(/\s+/u).filter(Boolean).join(' ');
  return !clean || clean === String(n)
    ? `=== page ${n} ===`
    : `=== page ${clean} (PDF page ${n}) ===`;
};

const sectionMarker = (depth, title) => {
  const clean = cleanText((title || '').split(/\s+/u).filter(Boolean).join(' '))
    .split('===')
    .join('= = =');
  return `=== ${'#'.repeat(Math.max(1, Math.min(MAX_DEPTH, depth)))} ${clean} ===`;
};

const defused = (text) =>
  text
    .split('\n')
    .map((line) => (MARKER_RE.test(line) ? line.split('===').join('= = =') : line))
    .join('\n');

// The stored text. `sections` is `[depth, title, page index]`, depth from 1.
export const assemble = (pages, labels = [], sections = []) => {
  const starting = new Map();
  for (const [depth, title, index] of sections.slice(0, MAX_SECTIONS)) {
    if (Number.isInteger(index) && index >= 0 && index < pages.length && (title || '').trim()) {
      if (!starting.has(index)) starting.set(index, []);
      starting.get(index).push([depth, title]);
    }
  }
  const out = [];
  pages.forEach((text, i) => {
    for (const [depth, title] of starting.get(i) || []) out.push(sectionMarker(depth, title));
    out.push(pageMarker(i, labels[i] || ''));
    if (text) out.push(defused(text));
  });
  return out.length ? `${out.join('\n')}\n` : '';
};

export const emptyPages = (pages) =>
  pages.filter((p) => (p || '').replace(/\s+/gu, '').length < EMPTY_PAGE_CHARS).length;

// No text layer to read: no pages, or more than half of them empty.
export const isScan = (pages) => !pages.length || emptyPages(pages) * 2 > pages.length;

// --- extracting, with pdf.js -------------------------------------------------------

// pdf.js's text items as pieces for runsFromItems. A right-to-left string pdf.js
// has already put in reading order goes back to drawing order, so a word drawn
// a letter at a time and one drawn whole are turned round the same way.
const itemsFromTextContent = (content) =>
  (content.items || [])
    .filter((it) => typeof it.str === 'string' && it.transform)
    // Turned text has a rotation in it. A slant alone (an oblique made from an
    // upright font) is still on the line.
    .filter((it) => {
      const [a, b] = it.transform;
      return !(Math.abs(b) > 0.01 * Math.abs(a || 1));
    })
    .map((it) => {
      const [, , , d, e, f] = it.transform;
      const text = it.dir === 'rtl' && len(it.str) > 1 ? logical(it.str) : it.str;
      return { text, x0: e, x1: e + (it.width || 0), y: f, size: Math.abs(d) };
    });

const outlineSections = async (doc) => {
  let outline;
  try {
    outline = await doc.getOutline();
  } catch {
    return [];
  }
  const out = [];
  const walk = async (items, depth) => {
    for (const item of items || []) {
      if (out.length >= MAX_SECTIONS) return;
      let index = null;
      try {
        const dest =
          typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
        const ref = Array.isArray(dest) ? dest[0] : null;
        if (Number.isInteger(ref)) index = ref;
        else if (ref && typeof ref === 'object') index = await doc.getPageIndex(ref);
      } catch {
        index = null;
      }
      if (Number.isInteger(index) && (item.title || '').trim())
        out.push([depth, item.title, index]);
      await walk(item.items, depth + 1);
    }
  };
  await walk(outline, 1);
  return out;
};

// The text of a loaded pdf.js document, laid out and marked.
// `onPage(done, total)` is told as pages are read.
export const pdfText = async (doc, { onPage } = {}) => {
  const total = doc.numPages;
  const pages = [];
  for (let n = 1; n <= total; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(cleanText(layoutPage(runsFromItems(itemsFromTextContent(content)))));
    page.cleanup?.();
    onPage?.(n, total);
  }
  const labels = await doc.getPageLabels().then(
    (got) => got || [],
    () => [],
  );
  const sections = await outlineSections(doc);
  return {
    text: assemble(pages, labels, sections),
    pages: total,
    sections,
    empty: emptyPages(pages),
    scan: isScan(pages),
  };
};
