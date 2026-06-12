// The vocab-item field inventory: the settled core fields plus the machinery for
// reading/normalizing a vocab layer's `igt.fields` config and humanizing field
// names for display.
//
// A vocab layer stores its field schema under `config.igt.fields` as
// `{ name: { inline: boolean } }` (read via readVocabFields in igtConfig.js).
// The `inline` flag is dual-purpose: an inline field shows BOTH as a column in
// the vocabulary management table AND in the interlinear view (the popover
// detail line). Non-inline fields are still editable in the per-item modal.
//
// Some fields are immutable — they can never be removed, because the app relies
// on them: `morphType` for rendering (affix joiners + the stem accent; see
// affixMarkers.js), `gloss` for the vocab list's Gloss column. New vocabs are
// seeded with the full core inventory; immutable fields are also guaranteed on
// existing vocabs (injected if missing).

/**
 * The core field inventory, in display order. `immutable` fields cannot be
 * removed and are pinned to the front (in this order). `inline` is the default
 * for a freshly-seeded vocab.
 */
export const CORE_VOCAB_FIELDS = [
  { name: 'morphType', inline: false, immutable: true },
  { name: 'gloss', inline: true, immutable: true },
  { name: 'pos', inline: true },
  { name: 'definition', inline: false },
];

const CORE_BY_NAME = new Map(CORE_VOCAB_FIELDS.map((f) => [f.name, f]));

/** Fields that must always be present, pinned first in this (core) order. */
const IMMUTABLE_NAMES = new Set(
  CORE_VOCAB_FIELDS.filter((f) => f.immutable).map((f) => f.name),
);

/** Human-friendly labels for known fields (overrides the generic humanizer). */
const FIELD_LABELS = {
  morphType: 'Morph Type',
  pos: 'POS',
  gloss: 'Gloss',
  definition: 'Definition',
  lexemeForm: 'Lexeme Form',
};

/**
 * Turn a raw field key into a human-friendly label: known overrides first, then
 * a generic camelCase/snake_case → Title Case split. e.g. "morphType" →
 * "Morph Type", "lexemeForm" → "Lexeme Form", "source_id" → "Source Id".
 */
export const humanizeFieldName = (name) => {
  if (FIELD_LABELS[name]) return FIELD_LABELS[name];
  const words = String(name ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
};

/** Which input control a field uses: morphType is a controlled-vocab select. */
export const fieldControl = (name) => (name === 'morphType' ? 'morphType' : 'text');

/**
 * Read a vocab layer's config into an ordered list of fields, tolerating the
 * legacy boolean format (`name: true|false`) and guaranteeing the immutable
 * core fields are present. `form` is never a field (it's the item's own form).
 *
 * @param {object} vocabFields - the raw `igt.fields` map (from readVocabFields)
 * @returns {{name: string, inline: boolean, immutable: boolean}[]}
 */
export const normalizeVocabFields = (vocabFields) => {
  const out = [];
  const seen = new Set();
  const add = (name, cfg) => {
    if (!name || name.toLowerCase() === 'form' || seen.has(name)) return;
    seen.add(name);
    const inline = typeof cfg === 'object' && cfg !== null ? !!cfg.inline : !!cfg;
    out.push({ name, inline, immutable: IMMUTABLE_NAMES.has(name) });
  };

  if (vocabFields && typeof vocabFields === 'object') {
    for (const [name, cfg] of Object.entries(vocabFields)) add(name, cfg);
  }

  // Force-inject any missing immutable field (using its core default for inline)
  // so it always shows up and can't be removed.
  for (const name of IMMUTABLE_NAMES) {
    if (!seen.has(name)) add(name, { inline: CORE_BY_NAME.get(name)?.inline ?? false });
  }

  // Immutable fields (morphType, then gloss) are pinned first in core order;
  // the rest keep their config order.
  const coreIdx = (name) => {
    const i = CORE_VOCAB_FIELDS.findIndex((f) => f.name === name);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const pinned = out.filter((f) => f.immutable).sort((a, b) => coreIdx(a.name) - coreIdx(b.name));
  const rest = out.filter((f) => !f.immutable);
  return [...pinned, ...rest];
};

/**
 * The `{ name: { inline } }` map to seed a brand-new vocab layer with the full
 * core inventory.
 */
export const seedDefaultFields = () =>
  Object.fromEntries(CORE_VOCAB_FIELDS.map((f) => [f.name, { inline: f.inline }]));

/** Serialize a normalized field list back to the stored `{ name: { inline } }` map. */
export const fieldsToConfig = (fields) =>
  Object.fromEntries(fields.map((f) => [f.name, { inline: !!f.inline }]));
