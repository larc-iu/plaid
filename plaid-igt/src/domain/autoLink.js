// Built-in vocab linking (run ON DEMAND from the Auto-link dialog — not
// automatically; see [[plaid-igt-provenance]] and the roadmap's P6). Policy:
//   PRECEDENT FIRST — follow the majority of existing same-form links across
//   the project (ties/contested = skip); with no precedent, link only when the
//   form matches exactly ONE vocab item; ambiguity always skips.
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
    where: [['vocab', '?v', { layer: vid }], ['vocab-link', '?t', '?v']],
    return: { group: ['?v', '?t.value', '?t.metadata.form'], aggregates: [['count']] },
  }));
}

// Merge precedent rows into form -> { itemId, contested }. Majority must be
// STRICT (top count > every other candidate's count); ties mark the form
// contested, which always skips (a precedent conflict signals ambiguity louder
// than no precedent at all).
export function buildPrecedentTable(resultsPerVocab) {
  const tally = new Map(); // form -> Map<itemId, n>
  for (const res of resultsPerVocab) {
    for (const [itemId, value, morphForm, n] of res?.results || []) {
      const form = (morphForm ?? value ?? '').toString();
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
    let bestN = 0;
    let second = 0;
    for (const [id, n] of m) {
      if (n > bestN) { second = bestN; best = id; bestN = n; }
      else if (n > second) second = n;
    }
    table.set(form, bestN > second ? { itemId: best, contested: false } : { itemId: null, contested: true });
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
    if (list) { if (!list.includes(id)) list.push(id); }
    else map.set(key, [id]);
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

// Resolution tiers: exact precedent > exact unique item > casefolded
// precedent > casefolded unique item. A contested precedent or a multi-item
// match at the consulted tier SKIPS (returns null) rather than falling
// through — ambiguity never auto-links.
function resolveForm(form, precedent, items) {
  const p = precedent.get(form);
  if (p) return p.contested ? null : p.itemId;
  const exact = items.exact.get(form);
  if (exact) return exact.length === 1 ? exact[0] : null;
  const lower = form.toLowerCase();
  const pf = precedent.get(lower);
  if (pf) return pf.contested ? null : pf.itemId;
  const folded = items.folded.get(lower);
  if (folded) return folded.length === 1 ? folded[0] : null;
  return null;
}

// Is a word/morpheme open to (re)linking, and what does it currently point at?
// Open when it has no link or only a machine-UNVERIFIED one; human and
// human-confirmed (verified) links are protected. `vocabItem.inferred` is the
// derived MACHINE flag (provState === 'machine'; see derive.js).
function linkTarget(entity) {
  const v = entity?.vocabItem;
  if (!v) return { open: true, currentItemId: null };
  return v.inferred ? { open: true, currentItemId: v.id } : { open: false, currentItemId: null };
}

// The built-in proposal provider: every word/morpheme open to linking whose
// form resolves to an item the rule would set. A form that resolves to the
// current (machine) link is a no-op and skipped; a protected or unresolvable
// link yields no proposal.
export function computeAutoLinkProposals({ sentences, vocabularies, precedentTable }) {
  const items = buildItemIndex(vocabularies);
  const proposals = [];
  const consider = (entity, form, kind) => {
    const { open, currentItemId } = linkTarget(entity);
    if (!open) return;
    const itemId = resolveForm(form ?? '', precedentTable, items);
    if (!itemId || itemId === currentItemId) return;
    proposals.push({ tokenId: entity.id, vocabItemId: itemId, form, kind });
  };
  for (const s of sentences || []) {
    for (const t of s.tokens || []) {
      consider(t, t.content, 'word');
      for (const m of t.morphemes || []) {
        const form = morphFormOf(m);
        if (form) consider(m, form, 'morpheme');
      }
    }
  }
  return proposals;
}
