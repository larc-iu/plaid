// Load-time invariant checker for UD (CoNLL-U) documents.
//
// Runs AFTER ConlluDocument.reconcileOnOpen's heals and reports anything still
// wrong. Deliberately NARROW: plaid-core enforces the structural invariants at
// write time — token extent bounds, referential integrity, span non-emptiness,
// parent containment, overlap modes (sentences partition; words non-overlap) —
// so re-checking them here would be pure noise. This only covers the APP-LEVEL
// UD contracts the server cannot know:
//
//   1. Heal-residue tripwires: re-run the heal planners and assert they come
//      back empty. A non-empty result post-heal means a heal silently failed.
//   2. Un-healable contracts where the repair needs a human (we cannot pick it
//      unambiguously) — currently multiple dependency heads on one node.
//
// Pure function. Returns findings [{severity, code, message, context}]; the
// caller logs the lot and surfaces one consolidated toast. Never throws.

import {
  interSententialRelationIds,
  wordsNeedingSyntacticWord,
  orphanSyntacticWords,
  planSpanDedup,
  multiHeadTargets,
} from '../utils/udReconcile.js';

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

export function validateConlluDocument(layerInfo) {
  const findings = [];
  const add = (severity, code, message, context = {}) =>
    findings.push({ severity, code, message, context });

  // --- (1) Heal-residue tripwires (should all be empty post-reconcile) ---
  try {
    const bare = wordsNeedingSyntacticWord(layerInfo);
    if (bare.length) {
      add(SEVERITY.ERROR, 'syntactic-word-missing',
        `${bare.length} word(s) still lack a syntactic-word after auto-repair.`,
        { extents: bare.map(w => `${w.begin}:${w.end}`) });
    }
    const orphans = orphanSyntacticWords(layerInfo);
    if (orphans.ids.length) {
      add(SEVERITY.ERROR, 'syntactic-word-orphan',
        `${orphans.ids.length} orphan syntactic-word(s) (matching no word) remain after auto-repair.`,
        { ids: orphans.ids });
    }
    const crossing = interSententialRelationIds(layerInfo);
    if (crossing.length) {
      add(SEVERITY.ERROR, 'relation-inter-sentential',
        `${crossing.length} dependency relation(s) still cross a sentence boundary after auto-repair.`,
        { ids: crossing });
    }
    const dedup = planSpanDedup(layerInfo);
    if (dedup.length) {
      add(SEVERITY.ERROR, 'span-duplicate',
        `${dedup.length} morpheme(s) still carry duplicate Form/Lemma/UPOS/XPOS spans after auto-repair.`,
        { tokens: dedup.map(d => `${d.field}@${d.tokenId}`) });
    }
  } catch (err) {
    add(SEVERITY.ERROR, 'residue-check-failed',
      `Invariant residue check threw: ${err?.message || err}`);
  }

  // --- (2) Un-healable app contracts (warn; repair needs a human) ---
  // More than one dependency head on a node: UD allows exactly one, and we
  // cannot know which is correct, so we only report it.
  multiHeadTargets(layerInfo).forEach(({ target, count }) => {
    add(SEVERITY.WARNING, 'multi-head',
      `A node has ${count} dependency heads (only one is allowed) — fix it by hand.`,
      { target, count });
  });

  return findings;
}

// Format findings for the clipboard "Copy details" action: one line each,
// machine-pasteable into a bug report.
export function formatFindingsForClipboard(findings, { documentId } = {}) {
  const header = documentId ? `Document integrity findings (document ${documentId})` : 'Document integrity findings';
  const lines = (findings || []).map(f =>
    `[${f.severity}] ${f.code}: ${f.message} ${JSON.stringify(f.context || {})}`);
  return [header, ...lines].join('\n');
}
