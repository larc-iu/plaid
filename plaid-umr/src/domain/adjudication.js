// The comparison report a Compare run leaves on a document, and the reading
// the Compare tab does of it. The report is written by the AnCast service
// (services/umr_ancast.py), and this is the one place its shape is read. The
// summary is the document's `metadata.umr.adjudication`, and each sentence's
// row is its sentence token's, at the same path, so no one write grows with
// the document:
//
//   document: { version, tool, against: {id, name}, at, scope, sentenceCount,
//               scores: { sentence, modal, temporal, coref, comprehensive } }
//   sentence: { index, at, concept, labeled, unlabeled, weighted, smatch,
//               matches: [{ this, other, thisConcept, otherConcept,
//                           leftover }],
//               unmatched: [var], unmatchedOther: [var], skipped }
//
// A row belongs to the report whose `at` it carries. A sentence with a row
// from an earlier run, or none, is not in the report.
//
// A match is a pair of variables AnCast put together, with both concepts as
// written: a pair whose concepts differ is a disagreement, and before the
// concepts were carried it read as agreement. `leftover` is a pair made only
// because both nodes were left once the others were paired.

import { UMR_NAMESPACE } from '../utils/umrLayerUtils.js';

/** The shape this reads. The service writes the same number. */
const REPORT_VERSION = 3;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The report, summary and rows together, or null. `raw` is the document as
 * `documents.get` returns it, and `sentenceTokens` its sentence tokens: a
 * row's `index` is its sentence's place among them, in text order.
 */
export const readAdjudication = (raw, sentenceTokens = []) => {
  const summary = raw?.metadata?.[UMR_NAMESPACE]?.adjudication;
  if (!isObject(summary) || summary.version !== REPORT_VERSION) return null;
  const sentences = [];
  [...(sentenceTokens || [])]
    .sort((a, b) => a.begin - b.begin)
    .forEach((token, i) => {
      const row = token?.metadata?.[UMR_NAMESPACE]?.adjudication;
      if (isObject(row) && row.at === summary.at) sentences.push({ ...row, index: i + 1 });
    });
  return { ...summary, sentences };
};

/** Whether a pair's two concepts differ. */
export const conceptsDiffer = (match) => match.thisConcept !== match.otherConcept;

/** A score as the tab prints it: `83%`, or `n/a` when it was not computed. */
export const percent = (x) =>
  typeof x === 'number' && Number.isFinite(x) ? `${Math.round(x * 100)}%` : 'n/a';

// The document-level scores in the order the tab lists them, with the
// label each carries.
const SCORE_LABELS = [
  ['sentence', 'Sentence graphs'],
  ['modal', 'Modal'],
  ['temporal', 'Temporal'],
  ['coref', 'Coreference'],
  ['comprehensive', 'Comprehensive'],
];

// A sentence-only run has the first alone. A document run has all five, and
// one it has no number for (a group neither document annotates) is a row
// that says so.
export const scoreRows = (report) =>
  (report?.scope === 'snt' ? SCORE_LABELS.slice(0, 1) : SCORE_LABELS).map(([key, label]) => ({
    key,
    label,
    value: typeof report?.scores?.[key] === 'number' ? report.scores[key] : null,
  }));

export const SENTENCE_SCORE_LABELS = [
  ['concept', 'Concepts'],
  ['labeled', 'Relations'],
  ['unlabeled', 'Unlabeled'],
  ['smatch', 'Smatch'],
];

/**
 * What each side of a sentence marks, by variable: `missing` for a node with
 * no counterpart, `differs` for one paired with a node of another concept.
 */
export const sentenceMarks = (row) => {
  const mine = new Map();
  const theirs = new Map();
  (row?.unmatched || []).forEach((v) => mine.set(v, 'missing'));
  (row?.unmatchedOther || []).forEach((v) => theirs.set(v, 'missing'));
  (row?.matches || []).filter(conceptsDiffer).forEach((m) => {
    mine.set(m.this, 'differs');
    theirs.set(m.other, 'differs');
  });
  return { mine, theirs };
};

// A PENMAN text cut into segments, the variables `marks` names carrying their
// mark: what the tab paints on each side so a disagreement stands out. A
// variable is matched as a whole token, so `s1p` never marks the inside of
// `s1p2`. In any script: a variable takes its letter from its concept, so
// `s1д` and `s2ł` are variables too.
export const markVariables = (text, marks) => {
  if (!text) return [];
  if (!marks?.size) return [{ text, mark: null }];
  const out = [];
  const re = /\p{L}[\p{L}\p{N}]*/gu;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const mark = marks.get(m[0]);
    if (!mark) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), mark: null });
    out.push({ text: m[0], mark });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mark: null });
  return out;
};

/** The report's row for a sentence number, or null. */
export const sentenceReport = (report, index) =>
  (report?.sentences || []).find((s) => Number(s.index) === Number(index)) || null;
