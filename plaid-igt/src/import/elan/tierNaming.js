// Reading a FieldWorks-shaped tier name, and pairing tiers with the fields a
// project already has.
//
// A corpus built for FieldWorks names its tiers after the interlinear item they
// carry and the writing system it is in: `Translation-gls-nl` is a free
// translation (FLEx's `gls`) in nl, `Transcription-txt-oni` the baseline in oni.
// (The speaker is normalized out before this, see baseTierName.) A project that
// came from the same FieldWorks project names the same fields "Translation
// (pmy)" and "Translation (nl)", or "Translation" and "Translation (nl)" when
// it was imported before every field carried its tag.
//
// The two conventions carry the same fact in different shapes, so the mapping
// can be worked out instead of typed.
//
// A field that RECORDS its writing system (config.igt.lang, which the FLEx
// importer writes) is matched on that and nothing else. Failing that, the tag
// in its name is the next best thing, and a field with neither is deduced:
// when a project has "Translation", "Translation (en)" and "Translation (nl)",
// and the corpus has tiers in en, nl and pmy, then en and nl pair by their
// tags and the one tier and one field left over must be each other. That last
// step is a guess, and it is only reached for fields nobody labelled.

import { isLangTag, parseFieldName, withLangSuffix } from '../../domain/fieldNames.js';

// What each FLEx item code is called in a field name, for the codes that have
// no name of their own in the IGT field vocabulary. Spelled out rather than
// left as the code, because a field name's parenthesized suffix is its
// WRITING SYSTEM and nothing else: "Word (pos)" read back through
// fieldNameLang is a field in the language `pos`, which the next document
// open records on the layer and both FLEx exporters then tag its values with.
const ITEM_WORDS = {
  txt: 'Text',
  msa: 'Morphosyntax',
  pos: 'POS',
  cf: 'Citation Form',
  hn: 'Homograph Number',
  punct: 'Punctuation',
};

// FLEx's <item type> vocabulary, which is what a tier name's middle segment is
// drawn from. Anything else means the name is not of this shape at all, so
// `interlinear-title-en` is left alone rather than read as a "title" item.
// The three with a name of their own (below) plus the ones named above, so a
// code cannot be known to one and not the other.
const ITEM_TYPES = new Set(['gls', 'lit', 'note', ...Object.keys(ITEM_WORDS)]);

// ELAN's own "Import FLEx" names a tier after the interlinear LEVEL and the
// item, behind a speaker prefix: `A_phrase-gls-en`, `A_word-pos-en`,
// `A_morph-type` (no writing system). The level says where the tier sits, so
// the field is named here by level and item, as the FLEx importer names the
// same item from a .flextext. Items it does not read (cf, hn, variantTypes,
// segnum) get a readable name all the same.
const LEVEL_ITEM_NAMES = {
  phrase: {
    txt: 'Text',
    gls: 'Translation',
    lit: 'Literal Translation',
    note: 'Note',
    segnum: 'Segment Number',
  },
  word: { gls: 'Gloss', pos: 'POS', txt: 'Text', punct: 'Punctuation' },
  morph: {
    gls: 'Gloss',
    msa: 'POS',
    cf: 'Citation Form',
    hn: 'Homograph Number',
    variantTypes: 'Variant Types',
    txt: 'Text',
    type: 'Type',
  },
};
const ELAN_FLEX_NAME = /^(?:[^_\s]+_)?(phrase|word|morph)-([A-Za-z]+)(?:-(.+))?$/;

/**
 * A tier named by ELAN's FLEx import: `A_morph-gls-en` → {level: 'morph',
 * itemType: 'gls', ws: 'en'}, `A_morph-type` → {level: 'morph', itemType:
 * 'type', ws: null}. Null for any other name.
 */
export function parseElanFlexTierName(name) {
  const m = ELAN_FLEX_NAME.exec(String(name ?? ''));
  if (!m) return null;
  const [, level, itemType, ws = null] = m;
  if (!LEVEL_ITEM_NAMES[level][itemType]) return null;
  if (ws != null && !isLangTag(ws)) return null;
  return { level, itemType, ws };
}

/**
 * `Translation-gls-nl` → {base: 'Translation', itemType: 'gls', ws: 'nl'}, or
 * null when the name is not shaped that way. A name from ELAN's FLEx import
 * (`A_phrase-gls-en`) reads as the field it holds, {base: 'Translation',
 * itemType: 'gls', ws: 'en', named: true}: its base is a level, not a name.
 */
export function parseFlexTierName(name) {
  const elan = parseElanFlexTierName(name);
  if (elan) {
    if (!elan.ws) return null;
    // A word's text in another writing system is an orthography, which the
    // FLEx importer names by the writing system.
    const base =
      elan.level === 'word' && elan.itemType === 'txt'
        ? elan.ws
        : LEVEL_ITEM_NAMES[elan.level][elan.itemType];
    return { base, itemType: elan.itemType, ws: elan.ws, named: true };
  }
  const parts = String(name ?? '').split('-');
  if (parts.length < 3) return null;
  const ws = parts.pop();
  const itemType = parts.pop();
  const base = parts.join('-');
  if (!base || !ITEM_TYPES.has(itemType)) return null;
  if (!isLangTag(ws)) return null;
  return { base, itemType, ws };
}

// Items whose values are in a vernacular writing system: a form, not an
// analysis. In a tier from ELAN's FLEx import their language is not one of
// the analysis languages that decide whether field names carry a tag, as in
// the FLEx importer, which tags Gloss and Translation by the analysis
// languages alone.
const FORM_ITEMS = new Set(['txt', 'cf', 'hn', 'punct']);
const isFormTier = (p) => p.named && FORM_ITEMS.has(p.itemType);

const fold = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * A field name for each FieldWorks-shaped tier, the one the FLEx importer gives
 * the same field: the base alone when the tiers are all in one language, the
 * base and the tag when they are in more than one (`Translation-gls-pmy` →
 * "Translation (pmy)" beside "Translation (en)"). FLEx's own item codes
 * ("gls", "txt") never reach a field name.
 *
 * `alsoIn` is the languages a project's existing fields are in. A tier joining
 * a project whose fields are in another language is one of several, and a bare
 * name could be one of those fields already.
 *
 * @param entries [{key, name}] — one per tier in a field role
 * @returns {Object<string, string>} node key → field name
 */
export function fieldWorksFieldNames(entries, alsoIn = []) {
  const parsed = (entries || [])
    .map((e) => [e.key, parseFlexTierName(e.name)])
    .filter(([, p]) => p);
  const languages = new Set([
    ...parsed.filter(([, p]) => !isFormTier(p)).map(([, p]) => p.ws),
    ...alsoIn.filter(Boolean),
  ]);
  // Those form tiers are tagged among themselves: two citation forms in two
  // vernaculars are two fields, whatever the glosses are in.
  const formLanguages = new Set(parsed.filter(([, p]) => isFormTier(p)).map(([, p]) => p.ws));
  const tagged = (p) => (isFormTier(p) ? formLanguages : languages).size > 1;
  // Two tiers of one base can differ only in FLEx's item code: a text's free
  // translation is `-gls-` and its literal one `-lit-`, which is how FLEx
  // itself writes them. Named by the base alone they were one field, and the
  // second tier's value was written over the first's, with nothing said.
  const codes = new Map();
  parsed.forEach(([, p]) => {
    const k = fold(p.base);
    if (!codes.has(k)) codes.set(k, new Set());
    codes.get(k).add(p.itemType);
  });
  const nameOf = (p) => {
    const base = !p.named && codes.get(fold(p.base)).size > 1 ? byItemType(p) : p.base;
    return tagged(p) ? withLangSuffix(base, p.ws) : base;
  };
  return Object.fromEntries(parsed.map(([key, p]) => [key, nameOf(p)]));
}

// What to call a tier when its base is shared: the name the FLEx importer
// gives the same item code, so a text that comes through either door lands in
// the same field.
function byItemType({ base, itemType }) {
  if (itemType === 'gls') return base;
  if (itemType === 'lit') return `Literal ${base}`;
  if (itemType === 'note') return `${base} Note`;
  return `${base} ${ITEM_WORDS[itemType]}`;
}

/**
 * The field each tier should write into, worked out from the names on both
 * sides. Only tiers whose names are FieldWorks-shaped get an answer; anything
 * else is left for the caller's own default.
 *
 * @param entries  [{key, name, scope}] — one per tier in a field role
 * @param existing {scope: [{name, id}]} — the project's own fields
 * @param fieldLangs {"<scope>:<name>" → tag} — what those fields record
 * @returns {Object<string, string>} node key → field name
 */
export function suggestFieldNames(entries, existing, fieldLangs = {}) {
  const out = {};
  // Grouped by what they are: one group decides its members together, because
  // the leftover pairing is only sound within a group.
  const groups = new Map();
  for (const entry of entries || []) {
    const parsed = parseFlexTierName(entry.name);
    if (!parsed) continue;
    const groupKey = `${entry.scope}:${fold(parsed.base)}:${parsed.itemType}`;
    if (!groups.has(groupKey))
      groups.set(groupKey, { scope: entry.scope, base: parsed.base, tiers: [] });
    groups.get(groupKey).tiers.push({ ...entry, ...parsed });
  }

  for (const group of groups.values()) {
    const fields = (existing?.[group.scope] || []).filter(
      (f) => fold(parseFieldName(f.name).base) === fold(group.base),
    );
    const claimed = new Set();
    const unmatched = [];
    // What a field says about itself outranks what its name looks like.
    const langOf = (f) =>
      fieldLangs?.[`${group.scope}:${f.name}`] ?? parseFieldName(f.name).ws ?? null;
    for (const tier of group.tiers) {
      const match = fields.find((f) => !claimed.has(f.name) && langOf(f) === tier.ws);
      if (match) {
        claimed.add(match.name);
        out[tier.key] = match.name;
      } else {
        unmatched.push(tier);
      }
    }
    // A field with no recorded language and no tag in its name: the primary
    // writing system, with nothing to say so. One tier left and one such field
    // left is that pairing, and it is the only guess this makes.
    const bare = fields.filter((f) => !claimed.has(f.name) && langOf(f) === null);
    if (unmatched.length === 1 && bare.length === 1) out[unmatched[0].key] = bare[0].name;
  }
  return out;
}
