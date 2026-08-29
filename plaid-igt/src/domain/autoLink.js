// Built-in vocab linking (run ON DEMAND from the Auto-analyze dialog — not
// automatically; see [[plaid-igt-provenance]] and the roadmap's P6). Policy:
//   PRECEDENT FIRST — follow the most-linked same-form item across the project,
//   preferring precedent set by the SAME KIND of token (a word follows what
//   words linked, a morpheme what morphemes linked) over precedent of any kind;
//   a tie on count breaks to the lexicographically smallest item id. With no
//   precedent, link to a matching vocab item; if several share the form, again
//   the lexicographically smallest id wins. Ties are rare, and the result is
//   stamped unverified for review, so an arbitrary-but-deterministic pick beats
//   refusing to link. An entry may be linked from words AND morphemes (a stem
//   is a morpheme in `dog-s` and the whole word in `dog`); the kind only ranks,
//   with one exception: a WORD never auto-links to a bound form (an entry
//   whose metadata.morphType is an affix or clitic), since a whole word is
//   not an affix. Such entries are skipped at every tier for word tokens.
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

import { PROV_STATES, ROLES } from '@larc-iu/plaid-client';

import { trimIgnoredEdges } from './igtConfig.js';
import { isBoundType } from './affixMarkers.js';

export const AUTO_LINK_SOURCE = 'rule:precedent-or-unique';

// The two kinds of token a link can hang off. Values are the token layers'
// shared `config.plaid.role`, which is what the precedent query groups by.
export const KINDS = Object.freeze({ WORD: ROLES.WORD, MORPHEME: ROLES.MORPHEME });

const morphFormOf = (m) => {
  const meta = m?.metadata;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'form')) return meta.form ?? '';
  return m?.content ?? '';
};

// One precedent query per vocab: how often each (form, item) pairing has been
// linked, project-wide, split by the kind of token that carries the link. Row
// shape: [itemId, tokenValue, morphForm, role, count] — the form is morphForm
// for morpheme tokens (their value is just the parent word's slice), tokenValue
// otherwise; the role is the token layer's shared `config.plaid.role`.
// `excludeDocId` leaves one document out, for a caller that tallies that
// document's links live from its own derived state (tallyDocumentLinks) and
// must not count them twice.
export function precedentQueries(vocabIds, { excludeDocId = null } = {}) {
  return vocabIds.map((vid) => ({
    where: [
      ['vocab', '?v', { layer: vid }],
      ['vocab-link', '?t', '?v'],
      ['token', '?t', { layer: '?tl' }],
      ['token-layer', '?tl', {}],
      ...(excludeDocId ? [['!=', '?t.doc', excludeDocId]] : []),
    ],
    return: {
      group: ['?v', '?t.value', '?t.metadata.form', '?tl.config.plaid.role'],
      aggregates: [['count']],
    },
  }));
}

// Pick the most-linked item out of itemId -> count. A tie on count breaks to
// the lexicographically smallest item id — ties are rare; pick one
// deterministically rather than skip.
function majority(counts) {
  let best = null;
  let bestN = -1;
  for (const [id, n] of counts) {
    if (n > bestN || (n === bestN && id < best)) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

// A precedent tally: form -> { any: Map<itemId, n>, [kind]: Map<itemId, n> },
// how many links each item has received from tokens with that form, overall
// and per kind of linking token (a kind is absent when no token of that kind
// ever linked the form).
const addTally = (tally, form, itemId, kind, n) => {
  if (!form) return;
  let entry = tally.get(form);
  if (!entry) tally.set(form, (entry = { any: new Map() }));
  const id = String(itemId);
  entry.any.set(id, (entry.any.get(id) || 0) + n);
  if (kind === KINDS.WORD || kind === KINDS.MORPHEME) {
    if (!entry[kind]) entry[kind] = new Map();
    entry[kind].set(id, (entry[kind].get(id) || 0) + n);
  }
};

// Fold precedent query rows (precedentQueries) into `tally`. `ignoredCfg`
// (the word layer's ignored-tokens config) trims edge punctuation off WORD
// values the same way the popover's "+ Create" does, so `derechos.` and
// `derechos` pool their precedent (morpheme forms are never trimmed).
export function tallyPrecedent(resultsPerVocab, ignoredCfg = null, tally = new Map()) {
  for (const res of resultsPerVocab) {
    for (const [itemId, value, morphForm, role, n] of res?.results || []) {
      const form =
        morphForm != null && morphForm !== ''
          ? String(morphForm)
          : trimIgnoredEdges((value ?? '').toString(), ignoredCfg);
      addTally(tally, form, itemId, role, n);
    }
  }
  return tally;
}

// Fold a derived document's own single-token links (derive.js sentences) into
// `tally`, one per linked word or morpheme, keyed the same way as the query
// rows. Pairs with `precedentQueries(..., { excludeDocId })`: the project
// tally is fetched once with the open document left out, and this keeps the
// document's share exact as links come and go without refetching.
export function tallyDocumentLinks(sentences, ignoredCfg = null, tally = new Map()) {
  for (const s of sentences || []) {
    for (const t of s.tokens || []) {
      if (t.vocabItem) {
        addTally(
          tally,
          trimIgnoredEdges(t.content ?? '', ignoredCfg),
          t.vocabItem.id,
          KINDS.WORD,
          1,
        );
      }
      for (const m of t.morphemes || []) {
        if (m.vocabItem) addTally(tally, morphFormOf(m), m.vocabItem.id, KINDS.MORPHEME, 1);
      }
    }
  }
  return tally;
}

// What a form's entry says to a token of `kind`: the same-kind slot when any
// token of that kind linked the form, else the overall slot.
const byKind = (entry, kind) => entry[kind] ?? entry.any ?? null;

// The link counts behind `form` as seen by a token of `kind` (itemId -> n),
// or null when the form has no precedent at all.
export function precedentCounts(tally, form, kind) {
  const entry = tally?.get(form);
  return entry ? byKind(entry, kind) : null;
}

// Merge precedent rows into form -> { any, word, morpheme }: the most-linked
// (form, item) pairing across the project overall and per kind of linking
// token. See tallyPrecedent for the form keying.
export function buildPrecedentTable(resultsPerVocab, ignoredCfg = null) {
  const tally = tallyPrecedent(resultsPerVocab, ignoredCfg);
  const table = new Map();
  for (const [form, entry] of tally) {
    const out = { any: majority(entry.any) };
    for (const kind of Object.values(KINDS)) {
      if (entry[kind]) out[kind] = majority(entry[kind]);
    }
    if (out.any != null) table.set(form, out);
  }
  return table;
}

// The precedent for `form` as seen by a token of `kind`: what tokens of that
// kind linked it before, else what any token did.
const precedentFor = (table, form, kind) => {
  const entry = table.get(form);
  return entry ? byKind(entry, kind) : null;
};

// form -> [itemIds] over the loaded vocab tables (exact), plus a casefolded
// variant for the fallback tier, plus the set of bound-form item ids (affix
// or clitic morphType) that word tokens must not take.
export function buildItemIndex(vocabularies) {
  const exact = new Map();
  const folded = new Map();
  const bound = new Set();
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
      if (isBoundType(it.metadata?.morphType)) bound.add(it.id);
    }
  }
  return { exact, folded, bound };
}

// Resolution tiers, first hit wins: exact precedent (same kind, then any) >
// exact item > casefolded precedent > casefolded item. Among multiple items
// sharing a form, the lexicographically smallest id is taken (precedent ties
// are already broken in buildPrecedentTable). A word token sees no bound-form
// entry at any tier. Returns null only when nothing matches at any tier.
const smallestId = (ids) => (ids && ids.length ? ids.reduce((a, b) => (b < a ? b : a)) : null);
function resolveForm(form, kind, precedent, items) {
  const ok = (id) => (id && !(kind === KINDS.WORD && items.bound.has(id)) ? id : null);
  const pick = (ids) => smallestId((ids || []).filter((id) => ok(id)));
  const p = ok(precedentFor(precedent, form, kind));
  if (p) return p;
  const exact = pick(items.exact.get(form));
  if (exact) return exact;
  const lower = form.toLowerCase();
  const pf = ok(precedentFor(precedent, lower, kind));
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
// MORPHEMES ARE RESOLVED FIRST: a single-morpheme word IS its morpheme, so
// when the morpheme carries or just received a link the word gets none (one
// chip, not two identical ones). A word with several morphemes may link on
// its own alongside them.
export function computeAutoLinkProposals({
  sentences,
  vocabularies,
  precedentTable,
  ignoredCfg = null,
}) {
  const items = buildItemIndex(vocabularies);
  const proposals = [];
  const consider = (entity, form, kind) => {
    const { open, currentItemId } = linkTarget(entity);
    if (!open) return;
    const itemId = resolveForm(form ?? '', kind, precedentTable, items);
    if (!itemId || itemId === currentItemId) return;
    proposals.push({ tokenId: entity.id, vocabItemId: itemId, form, kind });
  };
  const words = [];
  for (const s of sentences || []) for (const t of s.tokens || []) words.push(t);
  for (const t of words) {
    for (const m of t.morphemes || []) {
      const form = morphFormOf(m);
      if (form) consider(m, form, KINDS.MORPHEME);
    }
  }
  const proposedMorphs = new Set(proposals.map((p) => p.tokenId));
  for (const t of words) {
    const ms = t.morphemes || [];
    if (ms.length === 1 && (ms[0].vocabItem || proposedMorphs.has(ms[0].id))) continue;
    // Word forms lose edge punctuation by the project's ignore rule (the
    // same trim the popover's "+ Create" applies): `derechos.` links to
    // `derechos`. Morpheme forms are used verbatim.
    consider(t, trimIgnoredEdges(t.content ?? '', ignoredCfg), KINDS.WORD);
  }
  return proposals;
}
