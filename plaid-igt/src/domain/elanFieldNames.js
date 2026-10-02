// Which field an exported ELAN tier is, when its TIER_ID is not the field's
// name.
//
// TIER_ID is unique within a file, and a project imported from FLEx has Gloss
// and POS on words AND on morphemes. The exporter names the second tier of a
// name for its scope ("Morpheme Gloss") and records, in one HEADER property,
// the field each such tier is: {"Morpheme Gloss": "Gloss"}. The import reads
// the record, so a round trip keeps both fields' names. Keys are tier names
// without the speaker suffix.

export const ELAN_FIELD_NAMES_PROPERTY = 'plaid-igt:fieldNames';

/** The record as written: tier name → field name, or null when there is none. */
export function writeElanFieldNames(byTierName) {
  const entries = Object.entries(byTierName).filter(([tier, field]) => tier !== field);
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : null;
}

/** The record as read: a Map of tier name → field name, empty when absent or garbled. */
export function readElanFieldNames(value) {
  if (typeof value !== 'string' || value === '') return new Map();
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
  return new Map(
    Object.entries(parsed).filter(
      ([tier, field]) => tier !== '' && typeof field === 'string' && field.trim() !== '',
    ),
  );
}
