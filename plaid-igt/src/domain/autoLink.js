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
// The precedent itself is the shared tally in precedent.js (the same numbers
// the popover ranks by and the gloss guess reads); this file is only the
// resolution policy over it.
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

import { trimIgnoredEdges, isTokenIgnored } from './igtConfig.js';
import { isBoundType } from './affixMarkers.js';
import { isZeroMorph } from './zeroMorph.js';
import { KINDS, SLOT_LINK, precedentCounts, pickMajority } from './precedent.js';
import { isMweType, isContiguous, joinMweForm } from './mwe.js';

export const AUTO_LINK_SOURCE = 'rule:precedent-or-unique';

const morphFormOf = (m) => {
  const meta = m?.metadata;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'form')) return meta.form ?? '';
  return m?.content ?? '';
};

// The precedent for `form` as seen by a token of `kind`: the most-linked item
// among what tokens of that kind linked before, else among what any token
// did; a count tie breaks to the smallest id.
const precedentFor = (tally, form, kind) =>
  pickMajority(precedentCounts(tally, kind, form, SLOT_LINK), { tieBreak: 'smallest' });

// form -> [itemIds] over the loaded vocab tables (exact), plus a casefolded
// variant for the fallback tier, plus the set of bound-form item ids (affix
// or clitic morphType) that word tokens must not take, and the set of
// phrase-typed ids (multi-word expressions) that no single token takes.
export function buildItemIndex(vocabularies) {
  const exact = new Map();
  const folded = new Map();
  const bound = new Set();
  const phrase = new Set();
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
      if (isMweType(it.metadata?.morphType)) phrase.add(it.id);
    }
  }
  return { exact, folded, bound, phrase };
}

// Resolution tiers, first hit wins: exact precedent (same kind, then any) >
// exact item > casefolded precedent > casefolded item. Among multiple items
// sharing a form, the lexicographically smallest id is taken. A word token
// sees no bound-form entry at any tier, and no single token sees a
// phrase-typed one (those are for multi-word expressions, see
// computeMweProposals). Returns null only when nothing matches at any tier.
const smallestId = (ids) => (ids && ids.length ? ids.reduce((a, b) => (b < a ? b : a)) : null);
function resolveForm(form, kind, precedent, items) {
  const ok = (id) =>
    id && !(kind === KINDS.WORD && items.bound.has(id)) && !items.phrase.has(id) ? id : null;
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
// link yields no proposal. `precedent` is a precedent.js tally.
//
// MORPHEMES ARE RESOLVED FIRST: a single-morpheme word IS its morpheme, so
// when the morpheme carries or just received a link the word gets none (one
// chip, not two identical ones). A word with several morphemes may link on
// its own alongside them.
export function computeAutoLinkProposals({
  sentences,
  vocabularies,
  precedent,
  ignoredCfg = null,
}) {
  const items = buildItemIndex(vocabularies);
  const proposals = [];
  const consider = (entity, form, kind) => {
    // A zero morph is never auto-linked. Its form carries no information to
    // match on, so with one ∅ entry in the lexicon every zero in the project
    // would link to it, and with several `resolveForm` would pick by smallest
    // id. Linking a zero to the right entry is a human judgement, and it stays
    // available by hand: the lexicon popover still ranks ∅ entries for it.
    if (isZeroMorph(form)) return;
    const { open, currentItemId } = linkTarget(entity);
    if (!open) return;
    const itemId = resolveForm(form ?? '', kind, precedent, items);
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

// ---- multi-word expressions ----
// Runs of adjacent words are linked as one multi-word expression (MWE) when
// their joined surfaces match a phrase-typed entry's form, or match a run the
// open document already links as an MWE by hand (or has confirmed). Exact
// first, then casefolded, precedent before a form match, as for words. Only
// adjacent runs: a discontiguous expression is a person's call. A run that
// already carries an MWE over exactly those words is left alone, whatever it
// points at. Project-wide MWE precedent is out of reach (the query language
// cannot tell one link's tokens from another's), so precedent here is the
// document's own.
export const MWE_LINK_SOURCE = 'rule:mwe-precedent-or-form';

const wordCount = (form) => form.split(' ').length;

function buildPhraseIndex(vocabularies) {
  const exact = new Map();
  const folded = new Map();
  let longest = 0;
  const add = (map, key, id) => {
    const list = map.get(key);
    if (list) {
      if (!list.includes(id)) list.push(id);
    } else map.set(key, [id]);
  };
  for (const vocab of Object.values(vocabularies || {})) {
    for (const it of vocab.items || []) {
      if (!it.form || !isMweType(it.metadata?.morphType)) continue;
      const form = joinMweForm(it.form.split(/\s+/));
      if (wordCount(form) < 2) continue;
      add(exact, form, it.id);
      add(folded, form.toLowerCase(), it.id);
      longest = Math.max(longest, wordCount(form));
    }
  }
  return { exact, folded, longest };
}

// joined surfaces -> item -> count, from the document's adjacent MWEs a person
// made or confirmed; plus a casefolded variant.
function buildMwePrecedent(sentences, ignoredCfg) {
  const exact = new Map();
  const folded = new Map();
  const count = (map, key, id) => {
    let byItem = map.get(key);
    if (!byItem) map.set(key, (byItem = new Map()));
    byItem.set(id, (byItem.get(id) || 0) + 1);
  };
  let longest = 0;
  for (const s of sentences || []) {
    for (const m of s.mwes || []) {
      if (m.prov === PROV_STATES.MACHINE || !isContiguous(m.memberIdx)) continue;
      const form = joinMweForm(
        m.memberIdx.map((i) => trimIgnoredEdges(s.tokens[i]?.content ?? '', ignoredCfg)),
      );
      if (wordCount(form) < 2) continue;
      count(exact, form, m.item.id);
      count(folded, form.toLowerCase(), m.item.id);
      longest = Math.max(longest, wordCount(form));
    }
  }
  return { exact, folded, longest };
}

export function computeMweProposals({ sentences, vocabularies, ignoredCfg = null }) {
  const phrases = buildPhraseIndex(vocabularies);
  const precedent = buildMwePrecedent(sentences, ignoredCfg);
  const longest = Math.max(phrases.longest, precedent.longest);
  if (longest < 2) return [];
  const resolve = (form) => {
    const lower = form.toLowerCase();
    return (
      pickMajority(precedent.exact.get(form), { tieBreak: 'smallest' }) ||
      smallestId(phrases.exact.get(form)) ||
      pickMajority(precedent.folded.get(lower), { tieBreak: 'smallest' }) ||
      smallestId(phrases.folded.get(lower))
    );
  };
  const proposals = [];
  for (const s of sentences || []) {
    const covered = new Set((s.mwes || []).map((m) => m.memberTokenIds.join('\u0000')));
    const words = s.tokens || [];
    for (let i = 0; i < words.length; i++) {
      const run = [];
      for (let j = i; j < words.length && run.length < longest; j++) {
        // Punctuation the project ignores ends a run: "a , b" is no expression.
        if (isTokenIgnored(words[j].content, ignoredCfg)) break;
        run.push(words[j]);
        if (run.length < 2) continue;
        const form = joinMweForm(run.map((t) => trimIgnoredEdges(t.content ?? '', ignoredCfg)));
        if (wordCount(form) !== run.length) continue;
        const itemId = resolve(form);
        if (!itemId) continue;
        const tokenIds = run.map((t) => t.id);
        if (covered.has(tokenIds.join('\u0000'))) continue;
        proposals.push({ tokenIds, vocabItemId: itemId, form });
      }
    }
  }
  return proposals;
}
