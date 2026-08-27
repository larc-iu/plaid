// Load-time invariant checker for IGT documents.
//
// Runs AFTER reconcileOnOpen's heals (see IgtDocument.reconcileOnOpen) and
// reports anything still wrong. It is deliberately NARROW: plaid-core already
// enforces the structural invariants at write time — token extent bounds
// (begin<=end, within text), referential integrity (spans reference existing
// tokens in the right layer/doc), span non-emptiness, parent containment,
// overlap modes, vocab-link integrity — so re-checking them here would be pure
// noise. This only covers the APP-LEVEL contracts the server cannot know:
//
//   1. Heal-residue tripwires: re-run the heal planners and assert they come
//      back empty. A non-empty result post-heal means a heal silently failed
//      (or could not run) — the highest-value signal, and nearly free.
//   2. Genuinely un-healable contracts where the right repair needs a human
//      (we cannot pick it unambiguously), so we only warn.
//
// Pure function. Returns findings [{severity, code, message, context}]; the
// caller logs the lot and surfaces one consolidated toast. Never throws.

import { planMorphemeReconcile, planSpanDedup } from './igtReconcile.js';
import { buildLocalLevels } from './vocabLevels.js';

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

export function validateIgtDocument(layerInfo, alignmentTokens = [], vocabularies = null) {
  const findings = [];
  const add = (severity, code, message, context = {}) =>
    findings.push({ severity, code, message, context });

  // --- (0) Vocab-item level rule: an entry is linked from words or morphemes,
  // never both (vocabLevels.js). Only this document's links are visible here;
  // the project-wide picture is in IgtDocument.itemLevels.
  if (vocabularies) {
    try {
      const mixed = [...buildLocalLevels(layerInfo, vocabularies)]
        .filter(([, kinds]) => kinds.size > 1)
        .map(([id]) => id);
      if (mixed.length) {
        add(
          SEVERITY.WARNING,
          'vocab-item-mixed-levels',
          `${mixed.length} vocabulary entr${mixed.length === 1 ? 'y is' : 'ies are'} linked from both words and morphemes in this document; an entry should be one or the other.`,
          { items: mixed },
        );
      }
    } catch (err) {
      add(
        SEVERITY.WARNING,
        'level-check-failed',
        `Vocab level check crashed: ${err?.message || err}`,
      );
    }
  }

  // --- (1) Heal-residue tripwires (should all be empty post-reconcile) ---
  try {
    const { wordsNeedingMorpheme, orphanMorphemeIds } = planMorphemeReconcile(layerInfo);
    if (wordsNeedingMorpheme.length) {
      add(
        SEVERITY.ERROR,
        'morpheme-missing',
        `${wordsNeedingMorpheme.length} word(s) still lack a full-width morpheme after auto-repair.`,
        { extents: wordsNeedingMorpheme.map((w) => `${w.begin}:${w.end}`) },
      );
    }
    if (orphanMorphemeIds.length) {
      add(
        SEVERITY.ERROR,
        'morpheme-orphan',
        `${orphanMorphemeIds.length} orphan morpheme(s) (matching no word) remain after auto-repair.`,
        { ids: orphanMorphemeIds },
      );
    }
    const dedup = planSpanDedup(layerInfo);
    if (dedup.length) {
      add(
        SEVERITY.ERROR,
        'span-duplicate',
        `${dedup.length} token(s) still carry duplicate spans in a single layer after auto-repair.`,
        { tokens: dedup.map((d) => `${d.layerName || d.layerId}@${d.tokenId}`) },
      );
    }
  } catch (err) {
    add(
      SEVERITY.ERROR,
      'residue-check-failed',
      `Invariant residue check threw: ${err?.message || err}`,
    );
  }

  // --- (2) Un-healable app contracts (warn; repair needs a human) ---
  // Alignment timing must be non-inverted (timeEnd >= timeBegin). It lives in
  // opaque token metadata the server does not validate, and the repair (swap
  // the bounds vs. clear them) is ambiguous, so we only report it.
  (alignmentTokens || []).forEach((t) => {
    const tb = t.metadata?.timeBegin;
    const te = t.metadata?.timeEnd;
    if (typeof tb === 'number' && typeof te === 'number' && te < tb) {
      add(
        SEVERITY.WARNING,
        'alignment-time-inverted',
        `An alignment has end time (${te}) before start time (${tb}).`,
        { id: t.id, begin: t.begin, end: t.end, timeBegin: tb, timeEnd: te },
      );
    }
  });

  return findings;
}

// Format findings for the clipboard "Copy details" action: one line each,
// machine-pasteable into a bug report.
export function formatFindingsForClipboard(findings, { documentId } = {}) {
  const header = documentId
    ? `Document integrity findings (document ${documentId})`
    : 'Document integrity findings';
  const lines = (findings || []).map(
    (f) => `[${f.severity}] ${f.code}: ${f.message} ${JSON.stringify(f.context || {})}`,
  );
  return [header, ...lines].join('\n');
}
