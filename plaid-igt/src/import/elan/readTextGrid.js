// Read one Praat TextGrid into the IR readEaf produces, so a TextGrid goes
// through the ELAN import as it stands: the same tier review, the same roles,
// the same build. Pure: text in, structures out.
//
// THE FILE. Praat's text formats, long ("item [1]:", "xmin = 0") and short
// (the values alone), hold the same values in the same order, and Praat reads
// both by skipping everything but the values: numbers, quoted strings (a quote
// inside doubled) and the <exists> flag. So does this, and the labels and the
// "[1]" counters between them are never read. The binary format is refused.
//
// THE TIER TREE. A TextGrid's tiers are flat lists of intervals, and the tree
// ELAN gives them is read off their times, by two fixed rules, against the
// tiers BEFORE each one in the file, of the same speaker, that keep times of
// their own (a top tier or one under another by the second rule):
//
//   - Every interval with text has an interval with text of the same start and
//     end on such a tier: it hangs under the first, one value per interval
//     (Symbolic_Association). A translation tier under a transcription tier is
//     the usual case.
//   - Every interval with text lies inside one with text on such a tier: it
//     hangs under the last, the nearest before it, keeping its own times
//     (Included_In). Words under utterances and phones under words, as a
//     forced aligner writes them.
//   - Otherwise the tier is a top tier.
//
// An interval with no text is the gap between annotations and is not read.
// A point tier (TextTier) has nothing ELAN can hold, so it comes in as a tier
// with no annotations, which the review lists and gives no role.
//
// SPEAKERS. A tier named "name@Speaker" (the .eaf convention, and how the
// TextGrid export names a speaker's tiers) has that speaker as participant.

import { EafError, baseTierName } from './readEaf.js';
import { decodeText } from '@ui/lib/textFile.js';

const TYPE_TOP = 'TextGrid';
const TYPE_SAME = 'TextGrid (same times)';
const TYPE_INSIDE = 'TextGrid (inside)';

const LINGUISTIC_TYPES = Object.freeze({
  [TYPE_TOP]: { constraint: null, timeAlignable: true },
  [TYPE_SAME]: { constraint: 'Symbolic_Association', timeAlignable: false },
  [TYPE_INSIDE]: { constraint: 'Included_In', timeAlignable: true },
});

// The values of a Praat text file in order: {s} a string, {n} a number, {f} a
// flag. A "!" outside a string starts a comment to the end of the line, and
// a "[...]" is a counter in a label.
function values(text, fileName) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let s = '';
      i += 1;
      for (;;) {
        if (i >= n) throw new EafError(`${fileName} has a string with no closing quote.`);
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        s += text[i];
        i += 1;
      }
      out.push({ s });
    } else if (c === '!') {
      while (i < n && text[i] !== '\n') i += 1;
    } else if (c === '[') {
      while (i < n && text[i] !== ']') i += 1;
    } else if (c === '<') {
      const end = text.indexOf('>', i);
      out.push({ f: text.slice(i + 1, end < 0 ? n : end) });
      i = end < 0 ? n : end + 1;
    } else if (/[-+0-9.]/.test(c) && (i === 0 || !/[\p{L}_]/u.test(text[i - 1]))) {
      const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(text.slice(i, i + 64));
      if (m) {
        out.push({ n: Number(m[0]) });
        i += m[0].length;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return out;
}

const binaryError = (fileName) =>
  new EafError(`${fileName} is a binary TextGrid. Save it from Praat as a text file.`);

/**
 * A picked TextGrid file read and parsed. Praat's binary format starts with
 * the bytes "ooBinaryFile" and is not text in any encoding, so it is told
 * apart here, before the bytes are decoded.
 */
export async function readTextGridFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if ([...'ooBinaryFile'].every((c, i) => bytes[i] === c.charCodeAt(0))) {
    throw binaryError(file.name);
  }
  return readTextGrid(decodeText(bytes, file.name), file.name);
}

/**
 * Parse a TextGrid. The result has readEaf's shape, so the rest of the ELAN
 * import reads it unchanged.
 */
export function readTextGrid(text, fileName = 'file.TextGrid') {
  if (/^\uFEFF?ooBinaryFile/.test(text)) throw binaryError(fileName);
  const vals = values(text, fileName);
  let at = 0;
  const next = (kind, what) => {
    const v = vals[at];
    if (!v || !(kind in v)) {
      throw new EafError(`${fileName} is not a TextGrid Plaid can read: ${what} is missing.`);
    }
    at += 1;
    return v[kind];
  };
  if (next('s', 'the file type') !== 'ooTextFile' || next('s', 'the object class') !== 'TextGrid') {
    throw new EafError(`${fileName} is not a Praat TextGrid.`);
  }
  next('n', 'the start time');
  next('n', 'the end time');
  const tiers = [];
  const names = new Set();
  if (next('f', 'whether it has tiers') === 'exists') {
    const size = next('n', 'the number of tiers');
    for (let t = 0; t < size; t += 1) {
      const kind = next('s', 'a tier class');
      const name = next('s', 'a tier name');
      const at2 = name.lastIndexOf('@');
      const participant = at2 > 0 ? name.slice(at2 + 1).trim() : '';
      // Praat allows two tiers of one name and a tier with none. A tier is
      // known by its name from here on, so each gets one of its own.
      const base = (participant ? name.slice(0, at2) : name).trim() || `Tier ${t + 1}`;
      const full = (b) => (participant ? `${b}@${participant}` : b);
      let id = full(base);
      for (let k = 2; names.has(id); k += 1) id = full(`${base} (${k})`);
      names.add(id);
      next('n', 'a tier start');
      next('n', 'a tier end');
      const count = next('n', 'a tier size');
      const intervals = [];
      for (let k = 0; k < count; k += 1) {
        if (kind === 'IntervalTier') {
          const begin = next('n', 'an interval start');
          const end = next('n', 'an interval end');
          intervals.push({ begin, end, value: next('s', 'an interval text') });
        } else {
          next('n', 'a point time');
          next('s', 'a point text');
        }
      }
      tiers.push({
        id,
        participant,
        baseName: baseTierName(id, participant),
        annotator: '',
        typeRef: TYPE_TOP,
        parentRef: null,
        intervals: intervals.filter((iv) => iv.value.trim() !== ''),
        annotations: [],
      });
    }
  }

  // Milliseconds, as an .eaf has them. Matched on the rounded value, so two
  // tiers written from one time agree whatever the decimals.
  const ms = (s) => Math.round(s * 1000);
  let seq = 0;
  const nextId = () => `a${++seq}`;
  for (const tier of tiers) {
    for (const iv of tier.intervals) {
      iv.id = nextId();
      iv.beginMs = ms(iv.begin);
      iv.endMs = ms(iv.end);
    }
  }
  // Each tier's intervals by their times, and in time order, so a tier of
  // twenty thousand phones is matched against its words in one pass.
  const keyOf = (iv) => `${iv.beginMs}:${iv.endMs}`;
  for (const tier of tiers) {
    tier.byTimes = new Map(tier.intervals.map((iv) => [keyOf(iv), iv]));
    tier.sorted = [...tier.intervals].sort((x, y) => x.beginMs - y.beginMs || x.endMs - y.endMs);
  }
  // The interval of `sorted` that starts last at or before iv, if it also
  // ends at or after it.
  const holds = (sorted, iv) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].beginMs <= iv.beginMs) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && sorted[lo - 1].endMs >= iv.endMs;
  };
  tiers.forEach((tier, i) => {
    const earlier = tiers
      .slice(0, i)
      .filter((p) => p.participant === tier.participant && p.typeRef !== TYPE_SAME);
    const own = tier.intervals;
    const same = own.length
      ? earlier.find((p) => own.every((iv) => p.byTimes.has(keyOf(iv))))
      : null;
    const inside =
      !same && own.length ? earlier.findLast((p) => own.every((iv) => holds(p.sorted, iv))) : null;
    if (same) {
      tier.typeRef = TYPE_SAME;
      tier.parentRef = same.id;
      tier.annotations = own.map((iv) => ({
        id: iv.id,
        kind: 'ref',
        value: iv.value.normalize('NFC'),
        ref: same.byTimes.get(keyOf(iv)).id,
        previous: null,
        slotIndex: null,
        beginMs: null,
        endMs: null,
      }));
    } else {
      if (inside) {
        tier.typeRef = TYPE_INSIDE;
        tier.parentRef = inside.id;
      }
      tier.annotations = own.map((iv) => ({
        id: iv.id,
        kind: 'alignable',
        value: iv.value.normalize('NFC'),
        ref: null,
        previous: null,
        slotIndex: null,
        beginMs: iv.beginMs,
        endMs: iv.endMs,
      }));
    }
  });
  for (const tier of tiers) {
    delete tier.intervals;
    delete tier.byTimes;
    delete tier.sorted;
  }

  return {
    fileName,
    documentName:
      String(fileName)
        .split(/[\\/]/)
        .pop()
        .replace(/\.textgrid$/i, '') || 'Imported text',
    properties: {},
    media: [],
    linguisticTypes: { ...LINGUISTIC_TYPES },
    tiers,
  };
}
