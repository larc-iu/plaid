// Whole-word analysis memory: copy the project's previous full analysis of a
// word form — morpheme segmentation (forms + morphTypes), vocab links, and
// annotation values — onto unanalyzed occurrences of the same form. This is
// the FLEx-style "guess from previous analyses" effort reducer; in running
// text most tokens are repeats, so it converges toward "analyze each word
// type once."
//
// Policy (extends autoLink.js's, user decisions 2026-06-12):
//   apply immediately, every created/changed piece stamped { prov: 'inferred',
//   provSource } so it renders as unverified until a human confirms;
//   STRICT MAJORITY over identical whole-word analyses project-wide
//   (ties/contested = skip); exact form first, casefolded fallback;
//   only truly UNANALYZED words are ever touched (single bare default
//   morpheme, no links, no values) — existing work is never clobbered;
//   pure-machine sources don't count as precedent (an unverified copy must
//   not bootstrap more copies; FLEx-imported approved analyses are stamped
//   verified by the importer and do count).
//
// Pure functions only — the query/fetch/apply orchestration lives in
// autoPass.js and mutations/analysisCopy.js.

import { provState, PROV_STATES } from '@larc-iu/plaid-client';
import { isTokenIgnored } from './igtConfig.js';

export const ANALYSIS_COPY_SOURCE = 'rule:analysis-precedent';

const morphFormOf = (m) => {
  const meta = m?.metadata;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'form')) return meta.form ?? '';
  return m?.content ?? '';
};

// Non-empty annotation values of a derived token/morpheme: name -> span.
const filledAnnotations = (annotations) => {
  const out = [];
  for (const [name, span] of Object.entries(annotations || {})) {
    if ((span?.value ?? '') !== '') out.push([name, span]);
  }
  return out;
};

// Is this derived word token truly unanalyzed — eligible to receive a copy?
// Exactly one morpheme in the healed default state (form never set away from
// the word's surface, no morphType), and no links or annotation values
// anywhere on the word or its morpheme. Ignored tokens (punctuation) are
// never targets.
export function isUnanalyzedWord(token, ignoredCfg = null) {
  if (!token) return false;
  if (isTokenIgnored(token.content, ignoredCfg)) return false;
  if (token.vocabItem) return false;
  if (filledAnnotations(token.annotations).length) return false;
  const ms = token.morphemes || [];
  if (ms.length !== 1) return false;
  const m = ms[0];
  if (m.vocabItem) return false;
  if (filledAnnotations(m.annotations).length) return false;
  const meta = m.metadata || {};
  if (meta.morphType != null) return false;
  if (Object.prototype.hasOwnProperty.call(meta, 'form')
    && (meta.form ?? '') !== '' && meta.form !== token.content) return false;
  return true;
}

// Extract a copyable analysis from a derived word token, or null when the
// word has nothing to copy or only pure-machine-unverified content.
//
// Precedent voting: links and annotation spans vote with their provenance
// state; a word whose links/spans are ALL machine-unverified is excluded
// (rule above). Words with no links/spans at all (segmentation-only) fall
// back to the morpheme tokens' own metadata state, so a hand-segmented word
// still counts while an unverified copied segmentation doesn't.
export function extractAnalysis(token) {
  const ms = token.morphemes || [];
  if (!ms.length) return null;

  const votes = [];
  const segVotes = [];

  const word = { vocabItemId: null, fields: {} };
  if (token.vocabItem) {
    word.vocabItemId = token.vocabItem.id;
    votes.push(token.vocabItem.prov ?? PROV_STATES.HUMAN);
  }
  for (const [name, span] of filledAnnotations(token.annotations)) {
    word.fields[name] = span.value;
    votes.push(provState(span.metadata));
  }

  const morphemes = ms.map((m) => {
    const entry = {
      form: morphFormOf(m),
      morphType: m.metadata?.morphType ?? null,
      vocabItemId: null,
      fields: {},
    };
    if (m.vocabItem) {
      entry.vocabItemId = m.vocabItem.id;
      votes.push(m.vocabItem.prov ?? PROV_STATES.HUMAN);
    }
    for (const [name, span] of filledAnnotations(m.annotations)) {
      entry.fields[name] = span.value;
      votes.push(provState(span.metadata));
    }
    segVotes.push(provState(m.metadata));
    return entry;
  });

  // Anything to copy at all? (More than the bare default-morpheme state.)
  const contentful = word.vocabItemId
    || Object.keys(word.fields).length > 0
    || morphemes.length > 1
    || morphemes.some((m) => m.vocabItemId || Object.keys(m.fields).length > 0
      || m.morphType != null || m.form !== token.content);
  if (!contentful) return null;

  const voters = votes.length ? votes : segVotes;
  if (!voters.some((s) => s !== PROV_STATES.MACHINE)) return null;

  return { word, morphemes };
}

// Canonical signature so identical analyses tally together regardless of
// object key order.
export function analysisSignature(analysis) {
  const fieldPairs = (fields) => Object.keys(fields).sort().map((k) => [k, fields[k]]);
  return JSON.stringify([
    analysis.word.vocabItemId,
    fieldPairs(analysis.word.fields),
    analysis.morphemes.map((m) => [m.form, m.morphType, m.vocabItemId, fieldPairs(m.fields)]),
  ]);
}

// Accumulate one document's analyzed words into a tally:
// Map<form, Map<signature, { count, analysis }>>. Mutates and returns `tally`
// so per-document tallies can be cached and merged.
export function tallyAnalyses(tally, sentences, ignoredCfg = null) {
  for (const s of sentences || []) {
    for (const t of s.tokens || []) {
      if (!t.content) continue;
      if (isTokenIgnored(t.content, ignoredCfg)) continue;
      const analysis = extractAnalysis(t);
      if (!analysis) continue;
      let bySig = tally.get(t.content);
      if (!bySig) tally.set(t.content, (bySig = new Map()));
      const sig = analysisSignature(analysis);
      const entry = bySig.get(sig);
      if (entry) entry.count += 1;
      else bySig.set(sig, { count: 1, analysis });
    }
  }
  return tally;
}

export function mergeTallies(...tallies) {
  const out = new Map();
  for (const tally of tallies) {
    for (const [form, bySig] of tally) {
      let target = out.get(form);
      if (!target) out.set(form, (target = new Map()));
      for (const [sig, { count, analysis }] of bySig) {
        const entry = target.get(sig);
        if (entry) entry.count += count;
        else target.set(sig, { count, analysis });
      }
    }
  }
  return out;
}

// form -> { analysis, contested }. The winning signature's count must be a
// STRICT majority over every other signature's (matching autoLink's precedent
// rule): a tie marks the form contested, which always skips.
export function buildAnalysisTable(tally) {
  const table = new Map();
  for (const [form, bySig] of tally) {
    let best = null;
    let bestN = 0;
    let second = 0;
    for (const entry of bySig.values()) {
      if (entry.count > bestN) { second = bestN; best = entry.analysis; bestN = entry.count; }
      else if (entry.count > second) second = entry.count;
    }
    table.set(form, bestN > second ? { analysis: best, contested: false } : { analysis: null, contested: true });
  }
  return table;
}

// Exact form first, casefolded fallback. A contested entry at the consulted
// tier SKIPS rather than falling through (same shape as autoLink.resolveForm).
export function resolveAnalysisForForm(form, table) {
  const exact = table.get(form);
  if (exact) return exact.contested ? null : exact.analysis;
  const folded = table.get(form.toLowerCase());
  if (folded) return folded.contested ? null : folded.analysis;
  return null;
}

// Restrict an analysis to the configured copy contents. `copy` flags:
//   segmentation — morpheme breakdown, forms, morphTypes
//   links        — vocab links (word + morpheme)
//   fields       — annotation values (word + morpheme)
// Returns the filtered analysis, or null when nothing copyable remains.
// With segmentation off, a multi-morpheme analysis can't carry its
// morpheme-level material onto a single default morpheme — only the
// word-level parts survive.
export function filterAnalysis(analysis, copy = {}) {
  const { segmentation = true, links = true, fields = true } = copy;
  const strip = (entry) => ({
    ...entry,
    vocabItemId: links ? entry.vocabItemId : null,
    fields: fields ? entry.fields : {},
  });
  const word = strip({ ...analysis.word });
  let morphemes;
  if (segmentation) {
    morphemes = analysis.morphemes.map(strip);
  } else if (analysis.morphemes.length === 1) {
    // Keep the single morpheme as a carrier for its link/values, but drop the
    // form/morphType changes — those are segmentation-tier edits.
    const m = strip(analysis.morphemes[0]);
    morphemes = [{ ...m, form: null, morphType: null }];
  } else {
    morphemes = [];
  }
  const contentful = word.vocabItemId
    || Object.keys(word.fields).length > 0
    || morphemes.length > 1
    || morphemes.some((m) => m.vocabItemId || Object.keys(m.fields).length > 0
      || m.morphType != null || m.form != null);
  return contentful ? { word, morphemes } : null;
}

// Every unanalyzed word in the derived sentences whose form resolves to an
// uncontested majority analysis, filtered to the configured copy contents.
export function computeAnalysisCopyProposals({ sentences, ignoredCfg = null, table, copy = {} }) {
  const proposals = [];
  for (const s of sentences || []) {
    for (const t of s.tokens || []) {
      if (!isUnanalyzedWord(t, ignoredCfg)) continue;
      const analysis = resolveAnalysisForForm(t.content ?? '', table);
      if (!analysis) continue;
      const filtered = filterAnalysis(analysis, copy);
      if (filtered) proposals.push({ wordTokenId: t.id, form: t.content, analysis: filtered });
    }
  }
  return proposals;
}

// ---- project-wide source discovery -----------------------------------------
// The QL can't project scalar fields outside group-by, so (matching the
// concordance pattern) we ask one cheap question — which documents contain
// which word forms — then fetch the interesting documents and harvest their
// analyses locally with the same derivation the editor uses.

// One project-wide query: every (document, word form) pair with counts.
export const wordFormDocIndexQuery = (wordTokenLayerId) => ({
  where: [['token', '?t', { layer: wordTokenLayerId, doc: { var: '?d' } }]],
  return: { group: ['?d', '?t.value'], aggregates: [['count']] },
});

// Pick the documents worth fetching for a set of target forms: those
// containing an exact or casefolded match, ranked by matching-token count,
// capped. Returns { docIds, truncated }.
export function rankSourceDocs(result, targetForms, { excludeDocId = null, maxDocs = 25 } = {}) {
  const exact = new Set(targetForms);
  const folded = new Set([...targetForms].map((f) => f.toLowerCase()));
  const counts = new Map();
  for (const [docId, form, n] of result?.results || []) {
    const f = (form ?? '').toString();
    if (!f) continue;
    const d = String(docId);
    if (excludeDocId != null && d === String(excludeDocId)) continue;
    if (!exact.has(f) && !folded.has(f.toLowerCase())) continue;
    counts.set(d, (counts.get(d) || 0) + n);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    docIds: ranked.slice(0, maxDocs).map(([d]) => d),
    truncated: ranked.length > maxDocs,
  };
}
