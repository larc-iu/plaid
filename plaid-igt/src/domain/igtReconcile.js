// Reconcile-on-open planners for IGT documents.
//
// IGT's editor contract: every morpheme is full-width over its parent word,
// one annotation per field per token, one vocabulary link per token. The
// server holds those as layer rules and applies them inside every write
// (igtConstraints.js), so a word merged or split in another app never leaves
// an orphan morpheme or a doubled annotation behind. What is planned here is
// what the rules do not cover: caches and back-fills.

/** The label a reconcile pass that wrote nothing keeps. */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The audit label for a reconcile pass, naming what it actually changed.
 *
 * A constant label made a repair unreadable: the History drawer said
 * "Reconcile layers on open" and its member ops say "Patch metadata on token
 * 01a08827-... with 1 keys", so a document nobody had edited that session
 * carried an entry no one could account for. The counts are known before the
 * label is needed, so the entry can say which repair ran.
 *
 * Terse on purpose. This is a row in a drawer, not the console tally, and it
 * states what changed without the reasoning (that lives in the console line and
 * in these comments). Null when nothing was written, which leaves the pass its
 * plain label and, since a group is created lazily by its first write, usually
 * no entry at all.
 */
export const describeReconcile = ({
  rulesDeclared = false,
  rulesRepaired = false,
  syncedMorphTypes = 0,
} = {}) => {
  const parts = [];
  if (rulesRepaired) parts.push('fixed annotations the annotation rules forbid');
  if (rulesDeclared) parts.push('applied the annotation rules');
  if (syncedMorphTypes)
    parts.push(
      `synced ${plural(syncedMorphTypes, 'morpheme type', 'morpheme types')} from lexicon entries`,
    );
  if (!parts.length) return null;
  return `Repaired: ${parts.join(', ')}`;
};

/**
 * Morph-type sync plan: a morpheme linked to a lexicon entry takes the entry's
 * morphType (the entry is the source of truth; the token's metadata.morphType
 * is a cache for unlinked morphemes and for consumers that don't load the
 * lexicon). Every morpheme whose cached type differs from its entry's gets a
 * metadata patch. Entries without a type never override. Takes the DERIVED
 * sentences (morphemes carry `vocabItem` + `metadata`).
 * @returns {Array<{morphemeId: string, morphType: string}>}
 */
export const planMorphTypeSync = (sentences) => {
  const plans = [];
  for (const s of sentences || []) {
    for (const t of s.tokens || []) {
      for (const m of t.morphemes || []) {
        // The entry's type as derive resolved it (its own, else its
        // headword's), so a hand-made sense syncs its headword's type.
        const fromItem = m.entryMorphType ?? m.vocabItem?.metadata?.morphType;
        if (typeof fromItem !== 'string' || fromItem === '') continue;
        if ((m.metadata?.morphType ?? null) === fromItem) continue;
        plans.push({ morphemeId: m.id, morphType: fromItem });
      }
    }
  }
  return plans;
};

/**
 * Token layers that have not yet declared which metadata keys survive a split.
 *
 * A token born of a split is otherwise born bare, and provenance lost that way
 * leaves nothing for a later pass to find, so the declaration has to be in
 * place BEFORE the split rather than repaired after it. This is the back-fill
 * step of the reconcile contract: projects made before the declaration existed
 * pick it up the next time a maintainer opens a document.
 *
 * Only what the layer is missing is reported, so this is a no-op on the second
 * open and forever after.
 */
export const planPreserveOnSplit = (layerInfo, namespace, key, wanted) => {
  const layers = [
    layerInfo?.sentenceTokenLayer,
    layerInfo?.primaryTokenLayer,
    layerInfo?.morphemeTokenLayer,
    layerInfo?.alignmentTokenLayer,
  ];
  const out = [];
  for (const layer of layers) {
    if (!layer?.id) continue;
    const declared = layer.config?.[namespace]?.[key];
    const has = Array.isArray(declared) && wanted.every((k) => declared.includes(k));
    if (!has) out.push(layer.id);
  }
  return out;
};
