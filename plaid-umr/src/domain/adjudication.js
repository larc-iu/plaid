// The comparison report a Compare run leaves on a document, and the reading
// the Compare tab does of it. The report is written by the AnCast service
// (services/umr_ancast.py) under `metadata.umr.adjudication`, and this is
// the one place its shape is read.
//
//   { version, tool, against: {id, name}, at, scope,
//     scores: { sentence, modal, temporal, coref, comprehensive },
//     sentences: [{ index, concept, labeled, unlabeled, weighted, smatch,
//                   matches: [[thisVar, otherVar]], unmatched: [var],
//                   unmatchedOther: [var], skipped }] }

import { UMR_NAMESPACE } from '../utils/umrLayerUtils.js';

/** The report on a document as `documents.get` returns it, or null. */
export const readAdjudication = (raw) => {
  const report = raw?.metadata?.[UMR_NAMESPACE]?.adjudication;
  return report && typeof report === 'object' && Array.isArray(report.sentences) ? report : null;
};

/** A score as the tab prints it: `83%`, or `n/a` when it was not computed. */
export const percent = (x) =>
  typeof x === 'number' && Number.isFinite(x) ? `${Math.round(x * 100)}%` : 'n/a';

// The document-level scores in the order the tab lists them, with the
// label each carries. A sentence-only run has the first alone.
export const SCORE_LABELS = [
  ['sentence', 'Sentence graphs'],
  ['modal', 'Modal'],
  ['temporal', 'Temporal'],
  ['coref', 'Coreference'],
  ['comprehensive', 'Comprehensive'],
];

export const scoreRows = (report) =>
  SCORE_LABELS.filter(([key]) => typeof report?.scores?.[key] === 'number').map(([key, label]) => ({
    key,
    label,
    value: report.scores[key],
  }));

export const SENTENCE_SCORE_LABELS = [
  ['concept', 'Concepts'],
  ['labeled', 'Relations'],
  ['unlabeled', 'Unlabeled'],
  ['smatch', 'Smatch'],
];

// A PENMAN text cut into segments, the variables in `vars` marked: what the
// tab paints on each side so an unmatched node stands out. A variable is
// matched as a whole token, so `s1p` never marks the inside of `s1p2`.
export const markVariables = (text, vars) => {
  const wanted = new Set((vars || []).filter(Boolean));
  if (!text) return [];
  if (!wanted.size) return [{ text, marked: false }];
  const out = [];
  const re = /[A-Za-z][A-Za-z0-9]*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (!wanted.has(m[0])) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), marked: false });
    out.push({ text: m[0], marked: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), marked: false });
  return out;
};

/** The report's row for a sentence number, or null. */
export const sentenceReport = (report, index) =>
  (report?.sentences || []).find((s) => Number(s.index) === Number(index)) || null;
