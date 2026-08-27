// Built-in vocab linking (run ON DEMAND from the Auto-link dialog — not
// automatically; see [[plaid-igt-provenance]] and the roadmap's P6). Policy:
//   PRECEDENT FIRST — follow the most-linked same-form item across the project;
//   a tie on count breaks to the lexicographically smallest item id. With no
//   precedent, link to a matching vocab item; if several share the form, again
//   the lexicographically smallest id wins. Ties are rare, and the result is
//   stamped unverified for review, so an arbitrary-but-deterministic pick beats
//   refusing to link.
//   Case: exact form first, then a casefolded fallback (sentence-initial
//   capitals are everywhere in word tokens).
// Links are created with { prov: 'inferred', provSource } and NO provConfirmed
// — a human confirms by touching the link (popover), which patches
// provConfirmed: true.
//
// Provenance write contract (rule behaves like a re-runnable service): a
// word/morpheme with no link gets one; a link that is still machine-unverified
// is REPLACED when the rule now resolves to a different item; links a human
// made or confirmed are protected and never touched. A form the rule can't
// resolve leaves any existing link alone (re-running never strips a machine
// link the rule has lost its opinion on).
//
// Pluggability: computeAutoLinkProposals is the built-in provider; anything
// that produces [{ tokenId, vocabItemId }] proposals (including a service-
// backed provider) can feed IgtDocument.bulkLinkVocab the same way.

import { PROV_STATES } from '@larc-iu/plaid-client';

import { trimIgnoredEdges } from './igtConfig.js';
import { isLevelCompatible, LEVELS } from './vocabLevels.js';

export const AUTO_LINK_SOURCE = 'rule:precedent-or-unique';

const morphFormOf = (m) => {
  const meta = m?.metadata;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'form')) return meta.form ?? '';
  return m?.content ?? '';
};

// One precedent query per vocab: how often each (form, item) pairing has been
// linked, project-wide. Row shape: [itemId, tokenValue, morphForm, count] —
// the form is morphForm for morpheme tokens (their value is just the parent
// word's slice), tokenValue otherwise.
export function precedentQueries(vocabIds) {
  return vocabIds.map((vid) => ({
    where: [
      ['vocab', '?v', { layer: vid }],
      ['vocab-link', '?t', '?v'],
    ],
    return: { group: ['?v', '?t.value', '?t.metadata.form'], aggregates: [['count']] },
  }));
}

// Merge precedent rows into form -> itemId: the most-linked (form, item)
// pairing across the project. A tie on count breaks to the lexicographically
// smallest item id — ties are rare; pick one deterministically rather than skip.
// `ignoredCfg` (the word layer's ignored-tokens config) trims edge punctuation
// off WORD values the same way the popover's "+ Create" does, so `derechos.`
// and `derechos` pool their precedent (morpheme forms are never trimmed).
export function buildPrecedentTable(resultsPerVocab, ignoredCfg = null) {
  const tally = new Map(); // form -> Map<itemId, n>
  for (const res of resultsPerVocab) {
    for (const [itemId, value, morphForm, n] of res?.results || []) {
      const form =
        morphForm != null && morphForm !== ''
          ? String(morphForm)
          : trimIgnoredEdges((value ?? '').toString(), ignoredCfg);
      if (!form) continue;
      let m = tally.get(form);
      if (!m) tally.set(form, (m = new Map()));
      const id = String(itemId);
      m.set(id, (m.get(id) || 0) + n);
    }
  }
  const table = new Map();
  for (const [form, m] of tally) {
    let best = null;
    let bestN = -1;
    for (const [id, n] of m) {
      // Higher count wins; equal count breaks to the lexicographically smaller id.
      if (n > bestN || (n === bestN && id < best)) {
        best = id;
        bestN = n;
      }
    }
    if (best != null) table.set(form, best);
  }
  return table;
}

// form -> [itemIds] over the loaded vocab tables (exact), plus a casefolded
// variant for the fallback tier.
export function buildItemIndex(vocabularies) {
  const exact = new Map();
  const folded = new Map();
  const add = (map, key, id) => {
    const list = map.get(key);
    if (list) {
      if (!list.includes(id)) list.push(id);
    } else map.set(key, [id]);
  };
  for (const vocab of Object.values(vocabularies || {})) {
    for (const it of vocab.items || []) {
      if (!it.form) continue;
      add(exact, it.form, it.id);
      add(folded, it.form.toLowerCase(), it.id);
    }
  }
  return { exact, folded };
}

// Resolution tiers, first hit wins: exact precedent > exact item > casefolded
// precedent > casefolded item. Among multiple items sharing a form, the
// lexicographically smallest id is taken (precedent ties are already broken in
// buildPrecedentTable). Every tier is filtered by LEVEL compatibility: an item
// linked from the other kind of token elsewhere is invisible to this `kind`
// (see vocabLevels.js). Returns null only when nothing matches at any tier.
const smallestId = (ids) => (ids && ids.length ? ids.reduce((a, b) => (b < a ? b : a)) : null);
function resolveForm(form, kind, precedent, items, levels) {
  const ok = (id) => (id && isLevelCompatible(levels.get(id), kind) ? id : null);
  const pick = (ids) => smallestId((ids || []).filter((id) => ok(id)));
  const p = ok(precedent.get(form));
  if (p) return p;
  const exact = pick(items.exact.get(form));
  if (exact) return exact;
  const lower = form.toLowerCase();
  const pf = ok(precedent.get(lower));
  if (pf) return pf;
  return pick(items.folded.get(lower));
}

// Is a word/morpheme open to (re)linking, and what does it currently point at?
// Open when it has no link or only a machine-UNVERIFIED one; human and
// human-confirmed (verified) links are protected. `vocabItem.prov` is the
// derived provenance state of the link (see derive.js).
function linkTarget(entity) {
  const v = entity?.vocabItem;
  if (!v) return { open: true, currentItemId: null };
  return v.prov === PROV_STATES.MACHINE
    ? { open: true, currentItemId: v.id }
    : { open: false, currentItemId: null };
}

// The built-in proposal provider: every word/morpheme open to linking whose
// form resolves to an item the rule would set. A form that resolves to the
// current (machine) link is a no-op and skipped; a protected or unresolvable
// link yields no proposal.
//
// Levels: `itemLevels` (itemId -> 'word' | 'morpheme' | 'mixed' | null, see
// vocabLevels.js) is copied and updated as proposals claim never-linked items,
// so one pass never proposes an item at both levels. MORPHEMES ARE RESOLVED
// FIRST (user decision 2026-08-26): a single-morpheme word whose form matches
// a never-linked item at both levels links the morpheme only, and the word is
// left alone.
export function computeAutoLinkProposals({
  sentences,
  vocabularies,
  precedentTable,
  ignoredCfg = null,
  itemLevels = null,
}) {
  const items = buildItemIndex(vocabularies);
  const levels = new Map(itemLevels || []);
  const proposals = [];
  const consider = (entity, form, kind) => {
    const { open, currentItemId } = linkTarget(entity);
    if (!open) return;
    const itemId = resolveForm(form ?? '', kind, precedentTable, items, levels);
    if (!itemId || itemId === currentItemId) return;
    if (levels.get(itemId) == null) levels.set(itemId, kind); // first link fixes the level
    proposals.push({ tokenId: entity.id, vocabItemId: itemId, form, kind });
  };
  const words = [];
  for (const s of sentences || []) for (const t of s.tokens || []) words.push(t);
  for (const t of words) {
    for (const m of t.morphemes || []) {
      const form = morphFormOf(m);
      if (form) consider(m, form, LEVELS.MORPHEME);
    }
  }
  const proposedMorphs = new Set(proposals.map((p) => p.tokenId));
  for (const t of words) {
    // A single-morpheme word IS its morpheme: when that morpheme carries or
    // just received a link, the word gets none (one chip, at the morpheme
    // level), even if a different homonym would be free at the word level.
    const ms = t.morphemes || [];
    if (ms.length === 1 && (ms[0].vocabItem || proposedMorphs.has(ms[0].id))) continue;
    // Word forms lose edge punctuation by the project's ignore rule (the
    // same trim the popover's "+ Create" applies): `derechos.` links to
    // `derechos`. Morpheme forms are used verbatim.
    consider(t, trimIgnoredEdges(t.content ?? '', ignoredCfg), LEVELS.WORD);
  }
  return proposals;
}
