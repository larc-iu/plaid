// Load-time invariant checker for UD (CoNLL-U) documents.
//
// Runs AFTER ConlluDocument.reconcileOnOpen's heals and reports anything still
// wrong. Deliberately NARROW: plaid-core enforces the structural invariants at
// write time — token extent bounds, referential integrity, span non-emptiness,
// parent containment, overlap modes (sentences partition; words non-overlap) —
// so re-checking them here would be pure noise. This only covers the APP-LEVEL
// UD contracts the server cannot know: the tripwire of the one heal the app
// still makes (a bare word's first syntactic word). A relation across a
// sentence boundary, a second head, a stray syntactic word and a doubled
// annotation cannot be stored any more: the server's layer rules refuse or
// repair them in the write that would make one (utils/udConstraints.js).
//
// Pure function. Returns findings [{severity, code, message, context}]; the
// caller logs the lot and surfaces one consolidated toast. Never throws.

import { wordsNeedingSyntacticWord } from '../utils/udReconcile.js';

const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

export function validateConlluDocument(layerInfo) {
  const findings = [];
  const add = (severity, code, message, context = {}) =>
    findings.push({ severity, code, message, context });

  // --- The heal-residue tripwire (empty after reconcile) ---
  try {
    const bare = wordsNeedingSyntacticWord(layerInfo);
    if (bare.length) {
      add(
        SEVERITY.ERROR,
        'syntactic-word-missing',
        `${bare.length} word(s) still lack a syntactic-word after auto-repair.`,
        { extents: bare.map((w) => `${w.begin}:${w.end}`) },
      );
    }
  } catch (err) {
    add(
      SEVERITY.ERROR,
      'residue-check-failed',
      `Invariant residue check threw: ${err?.message || err}`,
    );
  }

  return findings;
}
