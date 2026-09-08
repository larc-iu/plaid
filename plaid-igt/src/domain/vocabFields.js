// The vocab-item field inventory: the settled core fields plus the machinery for
// reading/normalizing a vocab layer's `igt.fields` config and humanizing field
// names for display.
//
// A vocab layer stores its field schema under `config.igt.fields` as
// `{ name: { inline: boolean, tagset?: string, lang?: string } }` (read via
// readVocabFields in igtConfig.js). The `inline` flag is dual-purpose: an
// inline field shows BOTH as a column in the vocabulary management table AND
// in the interlinear view (the popover detail line). Non-inline fields are
// still editable in the per-item modal.
//
// `tagset` names one of the VOCABULARY's own tagsets (`config.igt.tagsets`,
// the same shape as a project's, see tagsets.js). A vocabulary is shared
// across projects and edited outside any of them, so its lists have to travel
// with it rather than borrow a project's. `lang` is the writing system of a
// FLEx custom field, read back by the LIFT export. Both ride along untouched
// through normalize/serialize; only `inline` is this module's own.
//
// `type` is what a field holds: `text` (the default) or `item`, a reference
// to another entry of the same vocabulary (`many` makes it a list of them).
// `scope` says whether the field belongs to the ENTRY (shown on a headword
// only) or to every SENSE (the default). See vocabDictionary.js.
//
// Some fields are immutable — they can never be removed, because the app relies
// on them: `morphType` for rendering (affix joiners + the stem accent; see
// affixMarkers.js), `gloss` for the vocab list's Gloss column. New vocabs are
// seeded with the full core inventory; immutable fields are also guaranteed on
// existing vocabs (injected if missing).

import { readTagsets } from './tagsets.js';

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
const IMMUTABLE_NAMES = new Set(CORE_VOCAB_FIELDS.filter((f) => f.immutable).map((f) => f.name));

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

/**
 * One line saying what a field is for, shown where a user has to decide what
 * belongs in it, currently the bulk-import column mapper. Every field is
 * optional on an entry. Only the form is required.
 */
const FIELD_DESCRIPTIONS = {
  morphType:
    'The kind of morph this entry is (stem, prefix, enclitic, …). Decides how it joins its neighbours in the interlinear line, so only FLEx morph-type names are accepted.',
  gloss: 'The short meaning shown under the form in the interlinear line.',
  pos: 'Part of speech.',
  definition: 'A fuller definition, shown in the entry detail rather than the interlinear line.',
  lexemeForm: 'The underlying form of the lexeme, when it differs from the form as written.',
};

export const fieldDescription = (name) =>
  FIELD_DESCRIPTIONS[name] ?? 'A custom field on this vocabulary. Free text.';

/**
 * A field's name without its writing-system suffix: "gloss (ru)" -> "gloss".
 * The FLEx import names the non-primary language of a multilingual field
 * this way, and the primary one keeps the bare name.
 */
export const fieldBaseName = (name) => String(name ?? '').replace(/\s\([^()]+\)$/, '');

const BUILT_IN_BASES = new Set([...CORE_VOCAB_FIELDS.map((f) => f.name), 'lexemeForm']);

/**
 * Whether a field is one the app itself knows (the core inventory and the
 * FLEx lexeme form), in any language, as opposed to one a user or an import
 * added. Shown apart on the entry form and marked in the field editor.
 */
export const isBuiltInField = (name) => BUILT_IN_BASES.has(fieldBaseName(name));

/**
 * The label a field is shown under. A field that carries a `lang` and does
 * not already say it in its name gets it appended, so the primary language
 * of a multilingual lexicon reads "Gloss (pt)" beside its "Gloss (en)"
 * rather than a bare "Gloss" that does not say which it is.
 */
export const fieldLabel = (field) => {
  const name = typeof field === 'string' ? field : field?.name;
  const lang = typeof field === 'string' ? null : str(field?.lang);
  const base = humanizeFieldName(name);
  return lang && fieldBaseName(name) === name ? `${base} (${lang})` : base;
};

/**
 * The entry form's groups, in the order they are shown: the built-in fields
 * (each followed by its other-language variants), then the custom text
 * fields, then the reference fields, with the named status field (a
 * dictionary's) pulled out to sit in the header. Within a group the config
 * order holds, except that a field's language variants follow it.
 */
export const groupFieldsForForm = (fields, { statusField = null } = {}) => {
  const out = { builtIn: [], custom: [], refs: [], status: null };
  const placed = new Set();
  const withVariants = (f, list) => {
    if (placed.has(f.name)) return;
    placed.add(f.name);
    list.push(f);
    for (const g of fields) {
      if (
        !placed.has(g.name) &&
        g.name !== f.name &&
        fieldBaseName(g.name) === fieldBaseName(f.name)
      ) {
        placed.add(g.name);
        list.push(g);
      }
    }
  };
  for (const f of fields || []) {
    if (statusField && f.name === statusField) {
      placed.add(f.name);
      out.status = f;
    }
  }
  // Bare built-in names first in core order, so "Gloss (en)" follows "Gloss"
  // even when the config lists it earlier.
  const coreOrder = [...BUILT_IN_BASES];
  const builtIn = (fields || []).filter((f) => isBuiltInField(f.name) && !placed.has(f.name));
  builtIn.sort(
    (a, b) =>
      coreOrder.indexOf(fieldBaseName(a.name)) - coreOrder.indexOf(fieldBaseName(b.name)) ||
      (fieldBaseName(a.name) === a.name ? 0 : 1) - (fieldBaseName(b.name) === b.name ? 0 : 1),
  );
  for (const f of builtIn) withVariants(f, out.builtIn);
  for (const f of fields || []) {
    if (placed.has(f.name) || f.type === FIELD_TYPES.ITEM) continue;
    withVariants(f, out.custom);
  }
  for (const f of fields || []) {
    if (placed.has(f.name)) continue;
    withVariants(f, out.refs);
  }
  return out;
};

/** Which input control a field uses: morphType is a controlled-vocab select. */
export const fieldControl = (name) => (name === 'morphType' ? 'morphType' : 'text');

/** The values `type` and `scope` may take. */
export const FIELD_TYPES = Object.freeze({ TEXT: 'text', ITEM: 'item' });
export const FIELD_SCOPES = Object.freeze({ ENTRY: 'entry', SENSE: 'sense' });

/**
 * Metadata keys an entry may carry that are never fields: the form is the
 * item's own column, and the rest are structure the app reads directly (the
 * sense tree, promoted examples, the FLEx import's identity keys). A field
 * may not take one of these names, so a schema can never shadow them.
 */
export const RESERVED_ITEM_KEYS = new Set([
  'form',
  'parent',
  'senseOrder',
  'examples',
  'flexEntry',
  'flexSense',
  'homograph',
]);

/**
 * A metadata map without its reserved keys: what the entry form edits. The
 * reserved keys are structure (the sense tree, examples, import identity)
 * that other controls write, so they never ride in the form's draft, or a
 * Save would write back what the draft remembered.
 */
export const editableMetadata = (metadata) =>
  Object.fromEntries(Object.entries(metadata || {}).filter(([k]) => !RESERVED_ITEM_KEYS.has(k)));

/** The reserved keys of a metadata map, the part a Save carries over unchanged. */
export const reservedMetadata = (metadata) =>
  Object.fromEntries(Object.entries(metadata || {}).filter(([k]) => RESERVED_ITEM_KEYS.has(k)));

/** Whether a field name is refused: reserved, compared without case. */
export const isReservedFieldName = (name) => {
  const n = String(name ?? '').trim();
  return [...RESERVED_ITEM_KEYS].some((k) => k.toLowerCase() === n.toLowerCase());
};

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const typeOf = (v) => (str(v) === FIELD_TYPES.ITEM ? FIELD_TYPES.ITEM : FIELD_TYPES.TEXT);
const scopeOf = (v) => (str(v) === FIELD_SCOPES.ENTRY ? FIELD_SCOPES.ENTRY : FIELD_SCOPES.SENSE);

/**
 * Read a vocab layer's config into an ordered list of fields, tolerating the
 * legacy boolean format (`name: true|false`) and guaranteeing the immutable
 * core fields are present. `form` is never a field (it's the item's own form).
 *
 * @param {object} vocabFields - the raw `igt.fields` map (from readVocabFields)
 * @returns {{name: string, inline: boolean, immutable: boolean, tagset: string|null, lang: string|null, type: string, many: boolean, scope: string}[]}
 */
export const normalizeVocabFields = (vocabFields) => {
  const out = [];
  const seen = new Set();
  const add = (name, cfg) => {
    if (!name || isReservedFieldName(name) || seen.has(name)) return;
    seen.add(name);
    const obj = typeof cfg === 'object' && cfg !== null ? cfg : null;
    const inline = obj ? !!obj.inline : !!cfg;
    // The core fields hold text whatever the config says: the editor reads
    // gloss and morphType as strings.
    const immutable = IMMUTABLE_NAMES.has(name);
    const type = immutable ? FIELD_TYPES.TEXT : typeOf(obj?.type);
    out.push({
      name,
      inline,
      immutable,
      tagset: str(obj?.tagset) || null,
      lang: str(obj?.lang) || null,
      type,
      many: type === FIELD_TYPES.ITEM && !!obj?.many,
      scope: scopeOf(obj?.scope),
    });
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

/**
 * Serialize a normalized field list back to the stored map. `tagset` and
 * `lang` are written only when set, so a field that never had them stays
 * `{ inline }` and a stored one is never dropped by an unrelated edit (an
 * inline toggle used to erase the FLEx importer's `lang`).
 */
export const fieldsToConfig = (fields) =>
  Object.fromEntries(
    fields.map((f) => [
      f.name,
      {
        inline: !!f.inline,
        ...(str(f.tagset) ? { tagset: str(f.tagset) } : {}),
        ...(str(f.lang) ? { lang: str(f.lang) } : {}),
        ...(f.type === FIELD_TYPES.ITEM ? { type: FIELD_TYPES.ITEM } : {}),
        ...(f.type === FIELD_TYPES.ITEM && f.many ? { many: true } : {}),
        ...(f.scope === FIELD_SCOPES.ENTRY ? { scope: FIELD_SCOPES.ENTRY } : {}),
      },
    ]),
  );

// ---- tagsets on vocabulary fields ------------------------------------------

/**
 * The tagset governing a field of this vocabulary, or null: the field names
 * none, or names one the vocabulary no longer has (a dangling reference
 * governs nothing, never an empty closed list; see resolveTagset in
 * tagsets.js for why).
 *
 * @param {{tagset?: string|null}} field - a normalized field
 * @param {object} vocabConfig - the vocab layer's whole `config`
 */
export const vocabFieldTagset = (field, vocabConfig) => {
  const name = str(field?.tagset);
  if (!name) return null;
  return readTagsets(vocabConfig)[name] ?? null;
};

/**
 * Every field of the vocabulary that a tagset governs, in the shape
 * TagsetsManager and byTagsetName read (`field`, `scope`, `kind`, `key`,
 * `tagsetName`, `tagset`): the vocabulary's own governedFields.
 *
 * @param {{name: string, tagset?: string|null}[]} fields - normalized fields
 * @param {object} vocabConfig - the vocab layer's whole `config`
 * @param {(name: string) => string} [label] - display name for a field
 */
export const vocabGovernedFields = (fields, vocabConfig, label = humanizeFieldName) => {
  const tagsets = readTagsets(vocabConfig);
  const out = [];
  for (const f of fields || []) {
    const tagsetName = str(f?.tagset);
    const tagset = tagsetName ? (tagsets[tagsetName] ?? null) : null;
    if (!tagset) continue;
    out.push({
      key: `vocab:${f.name}`,
      kind: 'vocab',
      field: label(f.name),
      name: f.name,
      scope: 'entry',
      layerId: null,
      tagsetName,
      tagset,
    });
  }
  return out;
};

/**
 * `field name -> tagset` for the governed fields only, the lookup the entry
 * editor and the bulk importer ask on every value.
 */
export const vocabTagsetByField = (fields, vocabConfig) => {
  const out = new Map();
  for (const g of vocabGovernedFields(fields, vocabConfig)) out.set(g.name, g.tagset);
  return out;
};
