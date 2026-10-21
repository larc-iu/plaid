// The pair picker's rows: what a morpheme's link and gloss can be set to
// together. Alt+Down on a morpheme's gloss and a click on its lexicon chip list
// the same rows, and a pick writes both halves in one batch
// (IgtDocument.setMorphemePair).
//
// A row is a sense (or no entry) and a value of the picker field, with where
// it comes from:
//
//   current   the morpheme's own link and value, pinned first
//   model     the producer's alternatives (provDetail.valueLinks name each
//             one's entry, valueProbs and value do not)
//   precedent the values this form was given in the project, with counts
//   lexicon   the senses of the linked entry, of the entries spelled like the
//             morpheme and of the entries it was linked to before, each with
//             its own value for the field (the field's Lexicon field)
//   tagset    the field's tagset values
//
// A row from a source that names no entry (precedent, tagset, a model value
// with no valueLinks entry) takes the morpheme's CURRENT link, so a pick never
// takes a link off. Unlinking is the chip's.

import { PROV, PROV_STATES, provState } from '@larc-iu/plaid-client';
import { collationKey, compareText } from '@ui/domain/collation.js';
import {
  isTrustedLink,
  PRECEDENT_SOURCE,
  TAGSET_SOURCE,
  VOCAB_ENTRY_SOURCE,
} from './glossGuess.js';
import { KINDS, precedentCounts, SLOT_LINK } from './precedent.js';
import { isValueAllowed, tagsetEnforces } from './tagsets.js';
import { groupRankedByHeadword, lexiconView } from './vocabDictionary.js';
import { rankVocabItems } from './vocabRank.js';

const DETAIL = PROV.detailKey;
const SOURCE = PROV.sourceKey;

// An entry's value for an entry field, '' when the field is none or the entry
// has no value in it.
const entryValue = (item, key) => {
  const v = key ? item?.metadata?.[key] : null;
  return v == null ? '' : String(v).trim();
};

/**
 * What the picker reads of one vocabulary: its items, the sense tree and
 * numbers, and its entries by form. Built once per data version by the
 * editor.
 */
export const pickerLexicon = (vocab) => {
  const items = vocab?.items || [];
  const view = lexiconView(items);
  const byForm = new Map();
  for (const it of items) {
    const k = collationKey(it.form);
    if (!byForm.has(k)) byForm.set(k, []);
    byForm.get(k).push(it);
  }
  return { id: vocab?.id, name: vocab?.name ?? '', items, ...view, byForm };
};

// Every entry of every vocabulary by id, with its vocabulary.
const indexOf = (lexicons) => {
  const byId = new Map();
  for (const lx of lexicons) for (const it of lx.items) byId.set(it.id, { item: it, lx });
  return byId;
};

/**
 * The vocabularies of a document for the picker, indexed once: a list of
 * pickerLexicon with `byId` on it, what pairRows reads on every cell.
 */
export const pickerLexicons = (lexicons) =>
  Object.assign([...lexicons], { byId: indexOf(lexicons) });

// The alternatives a gloss span's producer linked to lexicon entries
// (provDetail.valueLinks, a list of { value, item, prob }), keeping only
// entries the vocabularies still hold (an archive import or a merge renumbers
// items the record still names).
function valueLinksOf(span, itemExists = null) {
  const links = span?.metadata?.[DETAIL]?.valueLinks;
  if (!Array.isArray(links)) return [];
  return links.filter(
    (x) =>
      x &&
      typeof x.value === 'string' &&
      x.value !== '' &&
      typeof x.item === 'string' &&
      x.item &&
      (!itemExists || itemExists(x.item)),
  );
}

/**
 * The morpheme field whose values the chip's rows show: the first paired
 * field (one with a Lexicon field), in grid order, whose value records
 * alternatives with their entries, else the field paired with the entry
 * field `gloss`, else the first paired field. Null when the morpheme has none.
 *
 * @param {string[]} pairedFields the morpheme fields with a Lexicon field
 * @param {(name: string) => string|null} [lexiconFieldOf] each one's Lexicon field
 */
export function pickerFieldOf(morph, pairedFields, lexiconFieldOf = () => null) {
  const paired = pairedFields || [];
  return (
    paired.find((f) => valueLinksOf(morph?.annotations?.[f]).length) ??
    paired.find((f) => lexiconFieldOf(f) === 'gloss') ??
    paired[0] ??
    null
  );
}

// Tiers, in the order the list shows them.
const T = { CURRENT: 0, MODEL: 1, OWN: 2, PRECEDENT: 3, LEXICON: 4, TAGSET: 5 };

/**
 * The rows for a morpheme.
 *
 * @param {object} args
 * @param {object} args.morph the derived morpheme ({ vocabItem, annotations })
 * @param {string|null} args.field the picker field, or null for link-only rows
 * @param {string} args.form the morpheme's precedent form
 * @param {Map} [args.precedent] the precedent tally
 * @param {object[]} args.lexicons pickerLexicon per vocabulary
 * @param {string|null} [args.lexiconField] the field's Lexicon field, the entry
 *   field a sense's value is read from
 * @param {object|null} [args.tagset] the field's tagset, as the cell reads it
 * @param {string} [args.search] the chip's typed search
 * @param {Function} [args.detailOf] (item, lexicon) => the entry's detail line,
 *   for a search that matches it
 * @param {number} [args.cap] how many rows to keep
 * @param {boolean} [args.keepPersonValue] the chip's rows: over a value a
 *   person wrote or confirmed, a sense row links and keeps that value, and
 *   shows the sense's own as `senseValue`
 * @returns {{ rows: object[], more: number }}
 *
 * A row's entry is `named` when a source names it (the current link, a
 * producer's valueLinks, the lexicon). A row from a source that names none
 * carries the current link only to merge with the row of the same value, and
 * a pick of it leaves the link as it is.
 */
export function pairRows({
  morph,
  field,
  form,
  precedent = null,
  lexicons = [],
  lexiconField = null,
  tagset = null,
  search = '',
  detailOf = null,
  cap = Infinity,
  keepPersonValue = false,
}) {
  const byId = lexicons.byId ?? indexOf(lexicons);
  const current = morph?.vocabItem && byId.has(morph.vocabItem.id) ? morph.vocabItem : null;
  const currentId = current?.id ?? null;
  const span = field ? morph?.annotations?.[field] : null;
  const currentValue = span?.value ?? '';
  const enforcing = tagsetEnforces(tagset);
  const searching = !!search.trim();
  const q = collationKey(search.trim());

  // A sense's own value for the field, '' when it has none (an entry of a
  // vocabulary without the Lexicon field has none).
  const senseValue = (item) => entryValue(item, field ? lexiconField : null);

  const rows = new Map();
  let order = 0;
  const add = (itemId, value, tier, extra = {}) => {
    const key = `${itemId ?? ''}\u0000${value}`;
    let r = rows.get(key);
    if (!r) {
      const hit = itemId ? byId.get(itemId) : null;
      r = {
        key,
        itemId: itemId ?? null,
        item: hit?.item ?? null,
        vocabId: hit?.lx.id ?? null,
        vocabName: hit?.lx.name ?? '',
        sub: hit ? (hit.lx.numbers.get(itemId) ?? null) : null,
        value,
        tier,
        order: order++,
        prob: null,
        count: 0,
        model: false,
        current: false,
        lexicon: false,
        listed: false,
        description: null,
        depth: 0,
        context: false,
        source: null,
        linkSource: null,
        named: false,
      };
      rows.set(key, r);
    }
    if (tier < r.tier) r.tier = tier;
    for (const [k, v] of Object.entries(extra)) {
      if (k === 'prob') r.prob = Math.max(r.prob ?? 0, v);
      else if (k === 'count') r.count = Math.max(r.count, v);
      else if (v != null && v !== false && (r[k] == null || r[k] === false || r[k] === 0)) {
        r[k] = v;
      }
    }
    return r;
  };
  // A value an enforcing tagset refuses: a row naming an entry keeps the
  // entry and loses the value, any other row goes.
  const allowed = (value) => !enforcing || value === '' || isValueAllowed(value, tagset);
  const addPair = (itemId, value, tier, extra) => {
    if (!allowed(value)) {
      if (!itemId) return null;
      value = '';
    }
    return add(itemId, value, tier, extra);
  };

  // The current row.
  if (current || currentValue) {
    const r = add(currentId, currentValue, T.CURRENT, { current: true, named: !!current });
    // What a confirm of the current row would act on.
    r.linkState = current?.prov ?? null;
    r.valueMeta = span?.metadata ?? null;
  }

  // The producer's alternatives.
  const detail = span?.metadata?.[DETAIL];
  const producer = span?.metadata?.[SOURCE] || null;
  if (detail && typeof detail === 'object') {
    const linked = new Set();
    for (const x of valueLinksOf(span, (id) => byId.has(id))) {
      linked.add(x.value);
      const prob = typeof x.prob === 'number' ? x.prob : null;
      addPair(x.item, x.value, T.MODEL, {
        model: true,
        ...(prob != null ? { prob } : {}),
        source: producer,
        linkSource: producer,
        named: true,
      });
    }
    // Alternatives that name no entry, or whose entry is gone, keep the link.
    if (detail.valueProbs && typeof detail.valueProbs === 'object') {
      for (const [v, p] of Object.entries(detail.valueProbs)) {
        if (typeof p !== 'number' || v === '' || linked.has(v)) continue;
        addPair(currentId, v, T.MODEL, { model: true, prob: p, source: producer });
      }
    }
    if (typeof detail.value === 'string' && detail.value !== '' && !linked.has(detail.value)) {
      addPair(currentId, detail.value, T.MODEL, { model: true, source: producer });
    }
  }

  // Values the project gave this form.
  const counts = field ? precedentCounts(precedent, KINDS.MORPHEME, form, field) : null;
  for (const [v, n] of counts || []) {
    if (n > 0) addPair(currentId, v, T.PRECEDENT, { count: n, source: PRECEDENT_SOURCE });
  }

  // The lexicon: a typed search ranks every entry against the text, else the
  // trees of the linked entry, the entries this form was linked to and the
  // entries spelled like it.
  const lexRows = [];
  const linkCounts = precedentCounts(precedent, KINDS.MORPHEME, form, SLOT_LINK);
  for (const lx of lexicons) {
    let entries;
    if (searching) {
      const ranked = rankVocabItems(
        lx.items.map((it) => ({
          ...it,
          _detail: detailOf ? detailOf(it, lx) : senseValue(it),
        })),
        { form, search: search.trim() },
      );
      entries = groupRankedByHeadword(ranked, lx.items, lx.tree).map((g) => ({
        item: lx.byId.get(g.item.id) ?? g.item,
        depth: g.depth,
        context: !!g.context,
      }));
    } else {
      const roots = [];
      const seen = new Set();
      const root = (id) => {
        const r = lx.tree.rootOf.get(id) ?? id;
        if (!seen.has(r) && lx.byId.has(r)) {
          seen.add(r);
          roots.push(r);
        }
      };
      if (current && lx.byId.has(currentId)) root(currentId);
      const before = [...(linkCounts || [])]
        .filter(([id, n]) => n > 0 && lx.byId.has(id))
        .sort((a, b) => b[1] - a[1]);
      for (const [id] of before) root(id);
      for (const it of lx.byForm.get(collationKey(form)) || []) root(it.id);
      entries = [];
      const walk = (item, depth) => {
        const kids = lx.tree.childrenOf.get(item.id) || [];
        entries.push({ item, depth, context: false, hasKids: kids.length > 0 });
        for (const c of kids) walk(c, depth + 1);
      };
      for (const r of roots) walk(lx.byId.get(r), 0);
    }
    for (const e of entries) {
      const value = senseValue(e.item);
      // A headword with senses and no value of its own is there to group them.
      const context = e.context || (!searching && e.depth === 0 && !value && e.hasKids);
      lexRows.push({ id: e.item.id, value, depth: e.depth, context });
    }
  }
  for (const e of lexRows) {
    const r = addPair(e.id, e.value, T.LEXICON, {
      lexicon: true,
      named: true,
      source: e.value ? VOCAB_ENTRY_SOURCE : null,
    });
    if (r && r.tier === T.LEXICON) {
      r.depth = e.depth;
      r.context = e.context;
    }
  }
  // A person's link: its own sense ranks above precedent.
  if (current && isTrustedLink(current)) {
    const hit = byId.get(currentId);
    const own = rows.get(`${currentId}\u0000${senseValue(hit.item)}`);
    if (own && own.tier > T.OWN) own.tier = T.OWN;
  }

  // The tagset's own values.
  if (field && tagset) {
    for (const rec of tagset.values || []) {
      const r = add(currentId, rec.value, T.TAGSET, {
        listed: true,
        description: rec.description ?? null,
        source: TAGSET_SOURCE,
      });
      if (rec.description) r.description = rec.description;
    }
  }

  let list = [...rows.values()];
  // From the chip, a sense over a value a person wrote (a contributor
  // included) or confirmed links and keeps that value, when the value is the person's own rather than the one
  // that goes with the current link (the linked sense's own, or its
  // producer's for that entry): a value that only went with the old sense
  // moves with the pick. The row shows the value it keeps, and the sense's
  // own value as `senseValue`.
  const lexiconValue = (id) => {
    const hit = id ? byId.get(id) : null;
    return hit ? senseValue(hit.item) : '';
  };
  const pairedWithLink = new Set(
    current
      ? [
          lexiconValue(currentId),
          ...valueLinksOf(span)
            .filter((x) => x.item === currentId)
            .map((x) => x.value),
        ]
      : [],
  );
  const personValue =
    keepPersonValue &&
    currentValue !== '' &&
    provState(span?.metadata) !== PROV_STATES.MACHINE &&
    !pairedWithLink.has(currentValue);
  if (personValue) {
    const kept = new Map();
    for (const r of list) {
      if (r.named && r.itemId && !r.current && !r.context && r.value !== currentValue) {
        r.senseValue = lexiconValue(r.itemId) || r.value;
        r.value = currentValue;
        r.key = `${r.itemId}\u0000${currentValue}`;
      }
      const had = kept.get(r.key);
      if (!had || r.tier < had.tier) kept.set(r.key, r);
    }
    list = [...kept.values()];
  }
  if (enforcing) {
    // As listAlternatives: a value admitted only because it looks lexical has
    // to have been used more than once to be offered.
    list = list.filter(
      (r) => r.value === '' || r.current || r.listed || r.lexicon || r.model || r.count >= 2,
    );
  }
  // A typed search keeps the lexicon's matches and the values it is a prefix of.
  if (searching) {
    list = list.filter((r) => r.lexicon || (r.value !== '' && collationKey(r.value).startsWith(q)));
  }
  // Under an enforcing tagset, the senses whose value it refuses come after
  // its own values.
  const tierOf = (r) =>
    enforcing && r.tier === T.LEXICON && r.value === '' ? T.TAGSET + 1 : r.tier;
  list.sort((a, b) => {
    if (tierOf(a) !== tierOf(b)) return tierOf(a) - tierOf(b);
    if (a.tier === T.MODEL) {
      const d = (b.prob ?? -1) - (a.prob ?? -1);
      if (d) return d;
      return compareText(a.value, b.value) || a.order - b.order;
    }
    if (a.tier === T.PRECEDENT) return b.count - a.count || compareText(a.value, b.value);
    if (a.tier === T.TAGSET) return compareText(a.value, b.value);
    return a.order - b.order;
  });
  for (const r of list) {
    if (r.tier !== T.LEXICON) {
      r.depth = 0;
      r.context = false;
    }
    // What the pick writes, against what is there now.
    r.linkChange = r.named && r.itemId != null && r.itemId !== currentId;
    r.valueChange = r.value !== '' && r.value !== currentValue;
    r.pair = true;
  }
  const shown = list.slice(0, cap);
  const more = list.filter((r) => !r.context).length - shown.filter((r) => !r.context).length;
  return { rows: shown, more };
}

/**
 * The other paired fields a pick from the chip fills from the sense: each one
 * that is empty or holds a machine value nobody confirmed, given the sense's
 * own value for its Lexicon field, when that differs and the field's tagset
 * allows it.
 *
 * @param {object} args
 * @param {object} args.morph the derived morpheme
 * @param {object|null} args.item the picked sense
 * @param {string[]} args.fields the other morpheme fields with a Lexicon field
 * @param {(field: string) => { lexiconField, tagset }} args.fieldInfo
 * @returns {{ field: string, value: string }[]}
 */
export function senseFills({ morph, item, fields, fieldInfo }) {
  if (!item) return [];
  const out = [];
  for (const f of fields) {
    const span = morph?.annotations?.[f];
    const had = span?.value ?? '';
    if (had !== '' && provState(span?.metadata) !== PROV_STATES.MACHINE) continue;
    const { lexiconField = null, tagset = null } = fieldInfo(f) || {};
    const v = entryValue(item, lexiconField);
    if (!v || v === had) continue;
    if (tagset && !isValueAllowed(v, tagset)) continue;
    out.push({ field: f, value: v });
  }
  return out;
}
