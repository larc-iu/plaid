// Praat TextGrid serialization, in Praat's long text format ("ooTextFile").
//
//   File type = "ooTextFile"
//   Object class = "TextGrid"
//   xmin, xmax                       the whole grid, in seconds
//   tiers? <exists>, size = n
//   item [i]: class = "IntervalTier", name, xmin, xmax,
//             intervals: size = m, then each interval's xmin, xmax, text
//
// A TextGrid is a set of time lines and nothing else. An interval tier must
// cover the grid from xmin to xmax with no gaps and no overlaps, so the empty
// stretches between annotations are written as intervals with empty text. A
// tier has no parent, so the interlinear structure has nowhere to go beyond
// what one interval's text can hold.
//
// WHAT HAS A TIME. Only alignment segments carry times in Plaid. Words and
// morphemes do not, and this export never invents times for them: ELAN's own
// TextGrid export divides a sentence's span evenly among its words, which puts
// every word boundary at a place the speaker never put it. Instead each
// interlinear line becomes a tier of SENTENCE intervals whose text is that
// line for the whole sentence: "nzone yf rä" on the Morphemes tier,
// "1SG.POSS name 3SG..." on the Gloss tier, both spanning the sentence.
//
// The sentence span is the ELAN export's (sentenceTiming): the span of the
// alignment segments wholly inside the sentence. A sentence with none has no
// time and cannot be placed on a time line at all, so it is left out and
// counted, unlike in an .eaf, which can hold an unaligned annotation.
//
// TIERS, per speaker when asked (suffixed "@Speaker", as in the .eaf):
//   Sentence     the sentence's text
//   Segment      the alignment segments inside the sentences, always written,
//                so every file of one export has the same tiers in the same
//                order and a Praat script can address them by number. Empty
//                unless some sentence holds two or more segments, since at one
//                segment per sentence it would repeat the Sentence tier.
//   Words        the words as written (wordLine 'surface' or 'both')
//   Morphemes    the words segmented into morphemes (wordLine 'segmented' or
//                'both'), joined by their -/= markers
//   <orthography>, <morpheme field>, <word field>: one line each, words
//                separated by a space, morpheme values joined like the forms
//
// A word line has one item per word, so the n-th item of the Gloss tier
// belongs to the n-th item of the Words tier. A word with no value is written
// "_" to keep that count, and a line with no value at all is left empty.
// Punctuation is not a word and has no item: it stays on the Sentence tier.
//   <sentence field>: the field's value
//
// Pure functions: no DOM, no client.

import { tiers as igtLines } from '../domain/igtExport.js';
import {
  containedAlignments,
  sentenceSpeaker,
  sentenceTiming,
} from '../domain/sentenceSegments.js';
import { hasValidTimes } from '../domain/alignmentTimes.js';
import { nameAllocator } from './elan.js';
import { countOf } from '../../../plaid-ui/src/lib/plural.js';

/** Default names for the structural tiers. */
const TIER_NAMES = Object.freeze({
  sentence: 'Sentence',
  segment: 'Segment',
  surface: 'Words',
  segmented: 'Morphemes',
});

// Praat writes a string between double quotes and a double quote inside it
// doubled. Nothing else is escaped: a line break inside a value is legal,
// but a tier line is one line, so it becomes a space, as in every interlinear
// export.
const praatString = (s) =>
  `"${String(s ?? '')
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/"/g, '""')}"`;

// Seconds to the microsecond. Rounding is monotonic, so the order of two
// times and their equality survive it, and a time never comes out in
// exponent notation.
// Which columns of tiers() are words rather than the text between them
// (punctuation), read the way igtExport's columnCells makes them.
const wordColumns = (sentence) =>
  (sentence.pieces || (sentence.tokens || []).map(() => ({ type: 'token' })))
    .filter((p) => p.type === 'token' || (p.content ?? '').trim() !== '')
    .map((p) => p.type === 'token');

// One interlinear line as a tier's text: its word items, "_" for a word with
// no value, or nothing when no word has one.
const lineText = (cells, isWord) => {
  const items = cells.filter((_, i) => isWord[i]);
  return items.some((c) => c !== '') ? items.map((c) => (c === '' ? '_' : c)).join(' ') : '';
};

const seconds = (s) => String(Math.round(s * 1e6) / 1e6);
const micro = (s) => Math.round(s * 1e6);

/**
 * An interval tier from timed annotations [{begin, end, text}], sorted and
 * not overlapping, filled with empty intervals to cover [0, xmax].
 */
function intervalTier(name, annotations, xmax) {
  const intervals = [];
  let at = 0;
  for (const a of annotations) {
    if (micro(a.begin) > micro(at)) intervals.push({ begin: at, end: a.begin, text: '' });
    intervals.push(a);
    at = a.end;
  }
  if (micro(xmax) > micro(at) || intervals.length === 0) {
    intervals.push({ begin: at, end: xmax, text: '' });
  }
  return { name, intervals };
}

function tierText(tier, xmax, index) {
  const lines = [
    `    item [${index}]:`,
    '        class = "IntervalTier" ',
    `        name = ${praatString(tier.name)} `,
    '        xmin = 0 ',
    `        xmax = ${seconds(xmax)} `,
    `        intervals: size = ${tier.intervals.length} `,
  ];
  tier.intervals.forEach((iv, i) => {
    lines.push(
      `        intervals [${i + 1}]:`,
      `            xmin = ${seconds(iv.begin)} `,
      `            xmax = ${seconds(iv.end)} `,
      `            text = ${praatString(iv.text)} `,
    );
  });
  return lines;
}

/**
 * One IGT document as a TextGrid.
 *
 * options: the plain-text export's selection (orthographies, wordFields,
 *   morphFields, sentFields, wordLine), and perSpeaker.
 * context: { mediaSeconds, onWarning }. mediaSeconds is the recording's
 *   length when it is known, so the grid covers the whole recording in Praat
 *   rather than stopping at the last segment.
 */
export function buildTextGrid(igtDoc, options = {}, context = {}) {
  const { mediaSeconds = null, onWarning = null } = context;
  const body = [...(igtDoc.body ?? '')];
  const slice = (b, e) => body.slice(b, e).join('');
  const alignment = igtDoc.alignmentTokens || [];
  const valid = alignment.filter(hasValidTimes);

  const prelim = (igtDoc.sortedSentences || []).map((sentence) => {
    const timing = sentenceTiming(sentence, valid);
    return {
      sentence,
      speaker: sentenceSpeaker(sentence, alignment),
      // Seconds, from the segments themselves rather than the rounded
      // milliseconds an .eaf takes.
      span: timing && {
        begin: Math.min(...containedAlignments(sentence, valid).map((t) => t.metadata.timeBegin)),
        end: Math.max(...containedAlignments(sentence, valid).map((t) => t.metadata.timeEnd)),
      },
      inside: containedAlignments(sentence, valid),
    };
  });

  const speakers =
    options.perSpeaker !== false && prelim.some((p) => p.speaker)
      ? [...new Set(prelim.map((p) => p.speaker))]
      : [null];
  // Split, the speaker names the tier set, even when there is only one.
  const split = speakers.some((sp) => sp !== null);
  const groupOf = (p) => (split ? p.speaker : null);

  // An interval tier cannot hold two intervals at once. A sentence that
  // overlaps the one before it on its tier, which is two people talking at
  // once with the tiers not split by speaker, or one that has no length, is
  // left out and counted, as is one with no time at all.
  let untimed = 0;
  let overlapped = 0;
  for (const speaker of speakers) {
    let lastEnd = -Infinity;
    for (const p of prelim) {
      if (groupOf(p) !== speaker) continue;
      if (!p.span || micro(p.span.end) <= micro(p.span.begin)) {
        p.span = null;
        untimed += 1;
      } else if (micro(p.span.begin) < micro(lastEnd)) {
        p.span = null;
        overlapped += 1;
      } else {
        lastEnd = p.span.end;
      }
    }
  }
  if (untimed && onWarning) {
    onWarning(
      `${countOf(untimed, 'sentence')} with no time-aligned segment inside ${untimed === 1 ? 'it was' : 'them were'} left out. A TextGrid holds only what has a time.`,
    );
  }
  if (overlapped && onWarning) {
    onWarning(
      `${countOf(overlapped, 'sentence')} overlapping another on the same tier ${overlapped === 1 ? 'was' : 'were'} left out. Turn on "One tier set per speaker" to keep overlapping speech.`,
    );
  }

  const wantSegments = prelim.some((p) => p.span && p.inside.length > 1);
  const wordLine = options.wordLine || 'segmented';
  const selection = {
    wordLine,
    orthographies: options.orthographies || [],
    morphFields: options.morphFields || [],
    wordFields: options.wordFields || [],
  };

  // Field names first, so a field called "Sentence" keeps its name and the
  // structural tier is the one renamed (the .eaf export's rule).
  const alloc = nameAllocator();
  const orthNames = selection.orthographies.map((n) => alloc(n, 'Orthography', 'Orthography'));
  const morphNames = selection.morphFields.map((n) => alloc(n, 'MorphField', 'Morpheme'));
  const wordNames = selection.wordFields.map((n) => alloc(n, 'WordField', 'Word'));
  const sentNames = (options.sentFields || []).map((n) => alloc(n, 'SentField', 'Sentence'));
  const sentenceName = alloc(TIER_NAMES.sentence, 'Sentence');
  const segmentName = alloc(TIER_NAMES.segment, 'Segment');
  const surfaceName = wordLine !== 'segmented' ? alloc(TIER_NAMES.surface, 'Words') : null;
  const segmentedName = wordLine !== 'surface' ? alloc(TIER_NAMES.segmented, 'Morphemes') : null;

  const placed = prelim.filter((p) => p.span);
  const lastTime = Math.max(
    0,
    ...placed.map((p) => p.span.end),
    ...placed.flatMap((p) => p.inside.map((t) => t.metadata.timeEnd)),
  );
  const xmax = Math.max(lastTime, Number.isFinite(mediaSeconds) ? mediaSeconds : 0) || 1;

  const out = [];
  for (const speaker of speakers) {
    const suffix = speaker ? `@${speaker}` : '';
    const mine = placed.filter((p) => groupOf(p) === speaker);
    const rows = mine.map((p) => ({
      p,
      lines: igtLines(p.sentence, selection),
      isWord: wordColumns(p.sentence),
    }));
    // tiers() puts the word line(s) first, then orthographies, morpheme
    // fields and word fields, in the order the selection lists them.
    const lineTier = (name, lineIndex) =>
      intervalTier(
        `${name}${suffix}`,
        rows.map(({ p, lines, isWord }) => ({
          ...p.span,
          text: lineText(lines[lineIndex].cells, isWord),
        })),
        xmax,
      );

    out.push(
      intervalTier(
        `${sentenceName}${suffix}`,
        mine.map((p) => ({ ...p.span, text: slice(p.sentence.begin, p.sentence.end).trim() })),
        xmax,
      ),
    );
    out.push(
      intervalTier(
        `${segmentName}${suffix}`,
        wantSegments
          ? mine.flatMap((p) =>
              p.inside
                .filter((t) => micro(t.metadata.timeEnd) > micro(t.metadata.timeBegin))
                .map((t) => ({
                  begin: t.metadata.timeBegin,
                  end: t.metadata.timeEnd,
                  text: slice(t.begin, t.end).trim(),
                })),
            )
          : [],
        xmax,
      ),
    );
    let line = 0;
    if (surfaceName) out.push(lineTier(surfaceName, line++));
    if (segmentedName) out.push(lineTier(segmentedName, line++));
    for (const name of [...orthNames, ...morphNames, ...wordNames]) {
      out.push(lineTier(name, line++));
    }
    sentNames.forEach((name, i) => {
      const field = options.sentFields[i];
      out.push(
        intervalTier(
          `${name}${suffix}`,
          mine.map((p) => ({
            ...p.span,
            text: p.sentence.annotations?.[field]?.value ?? '',
          })),
          xmax,
        ),
      );
    });
  }

  return [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    '',
    'xmin = 0 ',
    `xmax = ${seconds(xmax)} `,
    'tiers? <exists> ',
    `size = ${out.length} `,
    'item []: ',
    ...out.flatMap((t, i) => tierText(t, xmax, i + 1)),
    '',
  ].join('\n');
}

/** A fresh preset's options: every line selected, one tier set per speaker. */
export const defaultTextGridOptions = (layers) => ({
  orthographies: [...(layers?.orthographies || [])],
  wordFields: [...(layers?.wordFields || [])],
  morphFields: [...(layers?.morphFields || [])],
  sentFields: [...(layers?.sentFields || [])],
  wordLine: layers?.hasMorphemes ? 'both' : 'surface',
  perSpeaker: true,
  includeMedia: true,
});
