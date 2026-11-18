// The report's totals as the job page says them, from the report alone: its
// rows of counts, and what is still blank of what the job fills. Pure, so the
// page's Overview and its sections read the same numbers.
import { fullTimestamp } from '@ui/lib/formatTime.js';
import { plural } from '@ui/lib/plural.js';
import {
  changesText,
  documentCounts,
  durationText,
  fieldValuesText,
  noticeCounts,
  noticeText,
  oneStep,
  sumParts,
} from './jobText.js';

// What is still blank of each thing the job fills (the plan's targets, by
// name): the totals' rows, or, when the totals hold none, the documents' rows
// summed by target in the order they come. Each `{target, unit, left,
// notReached, skipped}`, `unit` a word, a morpheme or a sentence (what Left
// blank lists).
// A job that fills nothing has none, and core's own report of a job no worker
// finished counts none.
export const blankSums = (report) => {
  if (report.totals?.blank) return report.totals.blank;
  const sums = new Map();
  (report.documents || []).forEach((d) =>
    (d.counts?.blank || []).forEach((b) => {
      const s = sums.get(b.target) ?? {
        target: b.target,
        unit: b.unit,
        left: 0,
        untouched: 0,
        notReached: 0,
        skipped: 0,
      };
      s.left += b.left ?? 0;
      s.unsegmented = (s.unsegmented ?? 0) + (b.unsegmented ?? 0);
      s.untouched += b.untouched ?? 0;
      s.notReached += b.notReached ?? 0;
      s.skipped += b.skipped ?? 0;
      sums.set(b.target, s);
    }),
  );
  return [...sums.values()];
};

// A count of what a target holds blank, in the unit Left blank lists.
export const unitCount = (n, unit) => `${n.toLocaleString()} ${plural(n, unit)}`;

// Rows `{field, id, values, inAnalyses?, outside?}` summed by the target's id (each row
// carries it, REV-SUFIX-2), named as the first row names it.
export const sumById = (rows, into = new Map()) => {
  rows.forEach((f) => {
    const s = into.get(f.id) ?? { field: f.field, id: f.id, values: 0 };
    s.values += f.values ?? 0;
    if (f.inAnalyses > 0) s.inAnalyses = (s.inAnalyses ?? 0) + f.inAnalyses;
    if (f.outside === true) s.outside = true;
    into.set(f.id, s);
  });
  return into;
};

// What the job wrote outside its setup, a row per target (the worker's
// `outside` rows, decided by id where it was written: values of a field, a
// translation or an orthography, and segmentation, one per word or morpheme,
// REV-SUFIX-1): the totals', or the documents' summed by id.
export const outsideRows = (report) => [
  ...sumById(
    report.totals?.outside ?? (report.documents || []).flatMap((d) => d.counts?.outside || []),
  ).values(),
];

// The values the job set in each target, in the order of their names: the
// totals' field rows, or, when the totals hold none (core's own report of a
// job no worker finished sums named counts only), the documents' summed by id.
// A target written outside the setup reads the count of its `outside` row,
// which also holds the values an analysis carries and a translation, so each
// such target has a row and those rows sum to the total.
export const fieldSums = (report) => {
  const sums = report.totals?.fields
    ? sumById(report.totals.fields)
    : sumById((report.documents || []).flatMap((d) => d.counts?.fields || []));
  outsideRows(report).forEach((f) =>
    sums.set(f.id, { ...f, inAnalyses: sums.get(f.id)?.inAnalyses, outside: true }),
  );
  return [...sums.values()].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
};

// What the job's changes are, by kind (the worker's `changes_parts`): the
// totals', or, when they hold none (core's own report), the documents' summed.
export const changeParts = (report) =>
  report.totals?.changesParts ??
  sumParts((report.documents || []).map((d) => d.counts?.changesParts));

// How many values the job wrote outside its setup: the sum of its rows.
export const outsideSum = (report) => outsideRows(report).reduce((n, f) => n + f.values, 0);

// One "label: value" row of the totals, left out when it is an optional row
// with nothing in it. The values the job set in each field follow the words
// it analyzed, one row per field ("Thematic role: 107 values"), then what is
// still blank of each thing the job fills, in the worked sentences and in
// those it did not reach ("Role left blank in sentences the job changed: 7 words"), so the rows sum.
export const totalRows = (report) => {
  const t = report.totals || {};
  // The documents as the table says them, one function with read_job's
  // (REV-RPF3-4): skipped apart from done (
  // REV-RPF-P-9), stopped partway apart from not reached (RPF3-D2).
  const docs = documentCounts(report);
  // A whole-selection job: the documents done and how many it changed, in one
  // row (RP4-4 finding 1, REV-SF2-7: "Documents done 3, changed 3").
  const stepped = (report.documents || []).some(oneStep);
  const rows = stepped
    ? [
        [
          'Documents done',
          `${docs.done.toLocaleString()}, changed ${docs.changed.toLocaleString()}`,
        ],
      ]
    : [['Documents done', docs.done]];
  const optional = (label, n) => n > 0 && rows.push([label, n]);
  // Ended by the plan's search with no model call, apart from done (SF).
  optional('Documents with nothing found by the plan’s search', docs.withNothingFoundByTheSearch);
  optional('Documents skipped', docs.skipped);
  optional('Documents in use', t.documentsInUse);
  optional('Documents deleted', t.documentsGone);
  optional('Documents not reached', docs.notReached);
  optional('Documents stopped partway', docs.stoppedPartway);
  rows.push(['Sentences written in', t.sentences]);
  // One definition of a change, said in its parts (RP-3, RP-6).
  if (t.changes > 0) rows.push(['Changes written', changesText(t.changes, changeParts(report))]);
  optional('Deletions', t.deletions);
  // Parts that ended without finishing, their steps used up or their answer
  // too long, what they had staged written (the worker's `pieces_ended`,
  // BRIEF RW, REV-RW-6).
  optional('Parts that ended unfinished', report.piecesEnded);
  // What the job changed of what people wrote, by provenance, and of the
  // text: each document's History entry shows the changes (REV-DAY-S-3).
  optional('People’s values, morphemes and links changed or removed', t.peoplesValuesChanged);
  optional('Changes to the text', t.textChanges);
  // What the text edits did to the words (RP-6).
  optional('Words added', t.wordsAdded);
  optional('Existing words or punctuation marks changed or removed', t.tokensChanged);
  optional('Translations written', t.translations);
  optional('Translations replaced', t.refreshed);
  optional('Words analyzed', t.words);
  fieldSums(report).forEach((f) => f.values > 0 && rows.push([f.field, fieldValuesText(f)]));
  optional('Values not in the setup', outsideSum(report));
  blankSums(report).forEach((b) => {
    // A target is named as everywhere on the page, "segmentation" too (N-1).
    // A word listed blank for a morpheme field because it has no morphemes
    // is said beside the field's morphemes, so the row adds up with the
    // list (RPF3-B).
    rows.push([
      `${b.target} left blank in sentences the job changed`,
      unitCount(b.left ?? 0, b.unit) +
        (b.unsegmented > 0 ? ` and ${unitCount(b.unsegmented, 'word')} not segmented` : ''),
    ]);
    // Counted, never listed: blank in sentences the job worked and wrote
    // nothing in (RP-3, RP-6).
    if (b.untouched > 0) {
      rows.push([
        `${b.target} blank in sentences the job did not change`,
        unitCount(b.untouched, b.unit),
      ]);
    }
    if (b.notReached > 0) {
      rows.push([`${b.target} blank in sentences not reached`, unitCount(b.notReached, b.unit)]);
    }
    if (b.skipped > 0) {
      rows.push([`${b.target} blank in skipped sentences`, unitCount(b.skipped, b.unit)]);
    }
  });
  optional('Lexicon links made', t.links);
  optional('Entries created', t.entries);
  optional('Changes proposed', t.proposed);
  optional('Sentences skipped as too long', t.skippedTooLong);
  optional('Sentences skipped as failed', t.skippedFailed);
  optional('Sentences skipped as changed during the job', t.skippedChanged);
  optional('Sentences skipped after an interrupted write', t.skippedInterrupted);
  optional('Sentences skipped with no answer from the assistant', t.skippedNoAnswer);
  optional('Sentences skipped and not listed', t.skippedMore);
  optional('Changes not written, changed during the job', t.changed);
  optional('Changes left out, sentence written before an interruption', t.repeated);
  return rows.map(([label, n]) => [label, typeof n === 'string' ? n : (n ?? 0).toLocaleString()]);
};

// How much of each thing the job fills is blank in the sentences of a
// document the job did not reach, or skipped (`key`): counted, never listed.
export const blankParts = (counts, key) =>
  (counts?.blank || [])
    .filter((b) => b[key] > 0)
    .map((b) => `${b.target} ${unitCount(b[key], b.unit)}`);

export const BLANK_ELSEWHERE = [
  ['untouched', 'Blank in sentences the job did not change'],
  ['notReached', 'Blank in sentences not reached'],
  ['skipped', 'Blank in skipped sentences'],
];

// Each wait named as the running page names it (RPF3-D1, RP2-1): taking
// turns with people's chats on the model is not waiting for people.
export const pausedRows = (report) =>
  [
    ['Taking turns with people using the model', report.pausedForPeopleS],
    ['Waiting for people to finish editing', report.pausedForEditsS],
    ['The model not answering', report.pausedForModelS],
  ]
    .filter(([, s]) => s > 0)
    .map(([l, s]) => [l, durationText(s * 1000)]);

// The report's documents with skipped sentences.
export const skippedDocuments = (report) =>
  (report.documents || []).filter((d) => d.skipped?.length);

// The report's documents with something under Left blank.
export const blankDocuments = (report) =>
  (report.documents || []).filter(
    (d) =>
      d.left?.length ||
      d.leftMore > 0 ||
      d.leftUnread ||
      BLANK_ELSEWHERE.some(([key]) => blankParts(d.counts, key).length > 0) ||
      d.refused?.length ||
      d.refusedMore > 0,
  );

// The lexicons of the project the job created entries in, in the project's
// order.
export const draftLexiconsOf = (report, vocabs = []) => {
  const madeIn = new Set(report.entries?.lexicons || []);
  return vocabs.filter((v) => madeIn.has(v.id));
};

// The top line of the report: the worker's own, or once the job is undone,
// the undo (RPF3-D3, RP2-4 finding 5).
export const noticeOf = (report, undone, undoneBy) =>
  undone
    ? `Undone by ${undoneBy}, ${fullTimestamp(undone.time)}. The counts below are what the job had written.`
    : report.notice !== undefined
      ? report.notice
      : noticeText(noticeCounts(report));
