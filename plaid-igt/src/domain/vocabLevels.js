// Vocab item LEVEL: a lexicon entry is linked either from WORDS or from
// MORPHEMES, never both (user decision 2026-08-26). The level is not stored:
// it is derived from the item's existing links, project-wide (a vocab is
// shared across projects, so links from other documents count too), and a
// never-linked item is fixed by its first link.
//
//   null        — no links anywhere yet; either kind may link it
//   'word'      — linked from word tokens only
//   'morpheme'  — linked from morpheme tokens only
//   'mixed'     — legacy/violation: links of both kinds (the validator yelps;
//                 nothing new may link it until a human cleans it up)
//
// Two sources are merged: the project-wide aggregate query (levelQueries →
// buildRemoteLevels, refreshed on load/reload) and the document's own live
// links (so a link made a moment ago fixes the level immediately, before any
// reload). Pure functions only; IgtDocument owns the fetch + caching.

import { ROLES } from '@larc-iu/plaid-client';

export const LEVELS = Object.freeze({ WORD: 'word', MORPHEME: 'morpheme', MIXED: 'mixed' });

// One aggregate per vocab: links per (item, token-layer role) across every
// readable project. Row shape: [itemId, role, count]; the role is the token
// layer's shared `config.plaid.role` ('word' / 'morpheme' / other).
export function levelQueries(vocabIds) {
  return (vocabIds || []).map((vid) => ({
    where: [
      ['vocab', '?v', { layer: vid }],
      ['vocab-link', '?t', '?v'],
      ['token', '?t', { layer: '?tl' }],
      ['token-layer', '?tl', {}],
    ],
    return: { group: ['?v', '?tl.config.plaid.role'], aggregates: [['count']] },
  }));
}

const kindOfRole = (role) =>
  role === ROLES.WORD ? LEVELS.WORD : role === ROLES.MORPHEME ? LEVELS.MORPHEME : null;

// Fold query results into itemId -> Set<'word'|'morpheme'>. Links on layers
// with other roles (another app's) are ignored.
export function buildRemoteLevels(resultsPerVocab) {
  const out = new Map();
  for (const res of resultsPerVocab || []) {
    for (const [itemId, role, n] of res?.results || []) {
      const kind = kindOfRole(role);
      if (!kind || !(n > 0)) continue;
      const id = String(itemId);
      if (!out.has(id)) out.set(id, new Set());
      out.get(id).add(kind);
    }
  }
  return out;
}

// itemId -> Set<kind> from the document's own links: a link's single token is
// a word if it lives on the word layer, a morpheme if on the morpheme layer.
export function buildLocalLevels(layerInfo, vocabularies) {
  const wordIds = new Set((layerInfo?.primaryTokenLayer?.tokens || []).map((t) => t.id));
  const morphIds = new Set((layerInfo?.morphemeTokenLayer?.tokens || []).map((t) => t.id));
  const out = new Map();
  for (const vocab of Object.values(vocabularies || {})) {
    for (const link of vocab.vocabLinks || []) {
      const itemId = link?.vocabItem?.id;
      if (!itemId || !Array.isArray(link.tokens) || link.tokens.length !== 1) continue;
      const tid = link.tokens[0];
      const kind = wordIds.has(tid) ? LEVELS.WORD : morphIds.has(tid) ? LEVELS.MORPHEME : null;
      if (!kind) continue;
      if (!out.has(itemId)) out.set(itemId, new Set());
      out.get(itemId).add(kind);
    }
  }
  return out;
}

const collapse = (set) => {
  if (!set || set.size === 0) return null;
  if (set.size > 1) return LEVELS.MIXED;
  return [...set][0];
};

// Merge remote + local kind sets into itemId -> level (see header).
export function buildItemLevels({ layerInfo, vocabularies, remote }) {
  const merged = new Map();
  const addAll = (source) => {
    for (const [id, kinds] of source || []) {
      if (!merged.has(id)) merged.set(id, new Set());
      for (const k of kinds) merged.get(id).add(k);
    }
  };
  addAll(remote);
  addAll(buildLocalLevels(layerInfo, vocabularies));
  const out = new Map();
  for (const [id, kinds] of merged) out.set(id, collapse(kinds));
  return out;
}

// May a token of `kind` ('word' | 'morpheme') link this item?
export const isLevelCompatible = (level, kind) => level == null || level === kind;

// Which kind of token is `tokenId` in this document (null if neither).
export function tokenKindOf(layerInfo, tokenId) {
  if ((layerInfo?.primaryTokenLayer?.tokens || []).some((t) => t.id === tokenId))
    return LEVELS.WORD;
  if ((layerInfo?.morphemeTokenLayer?.tokens || []).some((t) => t.id === tokenId)) {
    return LEVELS.MORPHEME;
  }
  return null;
}

// Human wording for the popover / errors.
export const otherLevel = (kind) => (kind === LEVELS.WORD ? LEVELS.MORPHEME : LEVELS.WORD);
