// Reading a FieldWorks-shaped tier name, and pairing tiers with the fields a
// project already has.
//
// A corpus built for FieldWorks names its tiers after the interlinear item they
// carry and the writing system it is in: `Translation-gls-nl` is a free
// translation (FLEx's `gls`) in nl, `Transcription-txt-oni` the baseline in oni.
// (The speaker is normalized out before this, see baseTierName.) A project that
// came from the same FieldWorks project names the same fields "Translation" and
// "Translation (nl)" — the convention on our side, where the PRIMARY analysis
// writing system takes the bare name.
//
// The two conventions carry the same fact in different shapes, so the mapping
// can be worked out instead of typed. What cannot be read off either side is
// WHICH writing system the bare field is in: Plaid records no language on an
// annotation field. It is deduced instead. When a project has "Translation",
// "Translation (en)" and "Translation (nl)", and the corpus has tiers in en, nl
// and pmy, then en and nl pair by their tags and the one tier and one field left
// over must be each other.

import { isLangTag, parseFieldName } from '../../domain/fieldNames.js';

// FLEx's <item type> vocabulary, which is what a tier name's middle segment is
// drawn from. Anything else means the name is not of this shape at all, so
// `interlinear-title-en` is left alone rather than read as a "title" item.
const ITEM_TYPES = new Set(['txt', 'gls', 'lit', 'note', 'msa', 'pos', 'cf', 'hn', 'punct']);

/**
 * `Translation-gls-nl` → {base: 'Translation', itemType: 'gls', ws: 'nl'}, or
 * null when the name is not shaped that way.
 */
export function parseFlexTierName(name) {
  const parts = String(name ?? '').split('-');
  if (parts.length < 3) return null;
  const ws = parts.pop();
  const itemType = parts.pop();
  const base = parts.join('-');
  if (!base || !ITEM_TYPES.has(itemType)) return null;
  if (!isLangTag(ws)) return null;
  return { base, itemType, ws };
}

const fold = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * The field each tier should write into, worked out from the names on both
 * sides. Only tiers whose names are FieldWorks-shaped get an answer; anything
 * else is left for the caller's own default.
 *
 * @param entries  [{key, name, scope}] — one per tier in a field role
 * @param existing {scope: [{name, id}]} — the project's own fields
 * @returns {Object<string, string>} node key → field name
 */
export function suggestFieldNames(entries, existing) {
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
    for (const tier of group.tiers) {
      const byTag = fields.find(
        (f) => !claimed.has(f.name) && parseFieldName(f.name).ws === tier.ws,
      );
      if (byTag) {
        claimed.add(byTag.name);
        out[tier.key] = byTag.name;
      } else {
        unmatched.push(tier);
      }
    }
    // The bare field is the primary writing system, and nothing records which
    // one that is. One tier left and one bare field left is that pairing.
    const bare = fields.filter((f) => !claimed.has(f.name) && parseFieldName(f.name).ws === null);
    if (unmatched.length === 1 && bare.length === 1) out[unmatched[0].key] = bare[0].name;
  }
  return out;
}
