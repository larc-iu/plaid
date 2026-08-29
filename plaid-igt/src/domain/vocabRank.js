// Ranking for the lexicon popover's candidate list.
//
// With no typed search, the list is ranked against the word/morpheme's own
// form, and PRECEDENT COMES FIRST: entries this form has been linked to before
// (project-wide, via the same tally the auto-linker follows) outrank a mere
// form match, ordered by how often. That is what makes an allomorph findable:
// `-ler` opens on the `-lar` entry it was linked to fifty times instead of
// burying it under fuzzy matches. Then the tiers: exact > prefix > substring
// on the form > match in the detail text > fuzzy, Levenshtein within a tier.
//
// A typed search overrides all of that: it ranks against the typed text
// only, precedent is ignored, and fuzzy-only "matches" are dropped (typing
// narrows).

export const TIERS = Object.freeze({
  PRECEDENT: -1,
  EXACT: 0,
  PREFIX: 1,
  SUBSTRING: 2,
  DETAIL: 3,
  FUZZY: 4,
});

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * @param {{id: string, form: string, _detail?: string}[]} items
 * @param {object} opts
 * @param {string} opts.form the word/morpheme's own form (default query)
 * @param {string} [opts.search] the typed search, if any
 * @param {Map<string, number>|null} [opts.precedent] itemId -> times this
 *   form was linked to it (precedentCounts in autoLink.js)
 * @returns {Array} the items to show, in order; each precedent-ranked item
 *   carries `_prec` (its count), everything else `_prec: null`.
 */
export function rankVocabItems(items, { form, search = '', precedent = null }) {
  const searching = !!search;
  const q = (searching ? search : form || '').toLowerCase();
  const prec = searching ? null : precedent;
  const tierOf = (it) => {
    const f = (it.form || '').toLowerCase();
    if (!searching && prec?.get(it.id)) return TIERS.PRECEDENT;
    if (!q) return TIERS.FUZZY;
    if (f === q) return TIERS.EXACT;
    if (f.startsWith(q)) return TIERS.PREFIX;
    if (f.includes(q)) return TIERS.SUBSTRING;
    if ((it._detail || '').toLowerCase().includes(q)) return TIERS.DETAIL;
    return TIERS.FUZZY;
  };
  let ranked = items.map((it) => {
    const tier = tierOf(it);
    return { ...it, _tier: tier, _prec: tier === TIERS.PRECEDENT ? prec.get(it.id) : null };
  });
  if (searching) ranked = ranked.filter((it) => it._tier < TIERS.FUZZY);
  ranked.sort((a, b) => {
    if (a._tier !== b._tier) return a._tier - b._tier;
    if (a._tier === TIERS.PRECEDENT && a._prec !== b._prec) return b._prec - a._prec;
    const d =
      levenshtein(q, (a.form || '').toLowerCase()) - levenshtein(q, (b.form || '').toLowerCase());
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ranked;
}
