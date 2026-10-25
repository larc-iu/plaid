// Controlled vocabularies, color palette, and config read/normalize helpers
// for Plaid UD. Pure module — no React, no client calls — so it is safe to
// import anywhere (components, utils, tests) and trivial to unit-test.
//
// Storage shape (all under the `ud` config namespace): vocab lists are plain
// string arrays; color maps are objects keyed by label (`{label: '#hex'}`); the
// feature inventory is an ordered list of `{key, values}` records (a list
// because the picker UI cares about order). The JS client treats `config` as an
// opaque bucket and passes it through verbatim — no key re-casing — so labels
// can safely be object keys, even hyphenated custom ones.

// By real path, so the node suite loads it (no `@ui` alias there).
import { CATEGORICAL } from '../../../plaid-ui/src/domain/dyes.js';
import { MODES, cleanDescriptions } from './udVocabMode.js';
import { UPOS_DESCRIPTIONS, DEPREL_DESCRIPTIONS } from './udVocabDescriptions.js';
import { readUdConfig } from '../domain/udConfig.js';

// UPOS is a CLOSED universal set of exactly 17 tags — not configurable.
export const UPOS_TAGS = Object.freeze([
  'ADJ',
  'ADP',
  'ADV',
  'AUX',
  'CCONJ',
  'DET',
  'INTJ',
  'NOUN',
  'NUM',
  'PART',
  'PRON',
  'PROPN',
  'PUNCT',
  'SCONJ',
  'SYM',
  'VERB',
  'X',
]);

// The 37 universal dependency relations — the seed baseline for the DEPREL
// vocabulary. Projects may add language-specific `:subtype` forms on top.
export const UNIVERSAL_DEPRELS = Object.freeze([
  'acl',
  'advcl',
  'advmod',
  'amod',
  'appos',
  'aux',
  'case',
  'cc',
  'ccomp',
  'clf',
  'compound',
  'conj',
  'cop',
  'csubj',
  'dep',
  'det',
  'discourse',
  'dislocated',
  'expl',
  'fixed',
  'flat',
  'goeswith',
  'iobj',
  'list',
  'mark',
  'nmod',
  'nsubj',
  'nummod',
  'obj',
  'obl',
  'orphan',
  'parataxis',
  'punct',
  'reparandum',
  'root',
  'vocative',
  'xcomp',
]);

// Default UD morphological feature inventory (universal features + values),
// used to seed the FEATS picker. Stored/edited as an array of {key, values}.
const UD_FEATURE_INVENTORY = Object.freeze([
  {
    key: 'PronType',
    values: ['Prs', 'Rcp', 'Art', 'Int', 'Rel', 'Dem', 'Tot', 'Neg', 'Ind', 'Exc', 'Emp'],
  },
  { key: 'NumType', values: ['Card', 'Ord', 'Mult', 'Frac', 'Sets', 'Dist', 'Range'] },
  { key: 'Poss', values: ['Yes'] },
  { key: 'Reflex', values: ['Yes'] },
  { key: 'Foreign', values: ['Yes'] },
  { key: 'Abbr', values: ['Yes'] },
  { key: 'Typo', values: ['Yes'] },
  { key: 'Gender', values: ['Masc', 'Fem', 'Neut', 'Com'] },
  { key: 'Animacy', values: ['Anim', 'Inan', 'Hum', 'Nhum'] },
  {
    key: 'Number',
    values: ['Sing', 'Plur', 'Dual', 'Ptan', 'Coll', 'Tri', 'Pauc', 'Grpa', 'Grpl', 'Inv', 'Count'],
  },
  {
    key: 'Case',
    values: [
      'Nom',
      'Acc',
      'Dat',
      'Gen',
      'Voc',
      'Loc',
      'Ins',
      'Abl',
      'Par',
      'Abs',
      'Erg',
      'Ess',
      'Tra',
      'Com',
      'Cau',
      'Ben',
    ],
  },
  { key: 'Definite', values: ['Def', 'Ind', 'Spec', 'Cons', 'Com'] },
  { key: 'Degree', values: ['Pos', 'Cmp', 'Sup', 'Abs', 'Equ'] },
  { key: 'VerbForm', values: ['Fin', 'Inf', 'Sup', 'Part', 'Ger', 'Gdv', 'Conv', 'Vnoun'] },
  {
    key: 'Mood',
    values: [
      'Ind',
      'Imp',
      'Cnd',
      'Pot',
      'Sub',
      'Jus',
      'Prp',
      'Qot',
      'Opt',
      'Des',
      'Nec',
      'Adm',
      'Irr',
    ],
  },
  { key: 'Tense', values: ['Past', 'Pres', 'Fut', 'Imp', 'Pqp'] },
  { key: 'Aspect', values: ['Imp', 'Perf', 'Prosp', 'Prog', 'Hab', 'Iter'] },
  { key: 'Voice', values: ['Act', 'Pass', 'Mid', 'Antip', 'Cau', 'Dir', 'Inv', 'Rcp'] },
  { key: 'Evident', values: ['Fh', 'Nfh'] },
  { key: 'Polarity', values: ['Pos', 'Neg'] },
  { key: 'Person', values: ['0', '1', '2', '3', '4'] },
  { key: 'Polite', values: ['Infm', 'Form', 'Elev', 'Humb'] },
  { key: 'Clusivity', values: ['In', 'Ex'] },
]);

// Strip a `:subtype` so a relation and its subtypes share one color
// (e.g. nsubj and nsubj:pass both key on `nsubj`).
export const baseRel = (deprel) => (deprel || '').split(':')[0];

// Labels with no configured colour take one of the cloth's dyes (plaid-ui's
// categorical palette), each dark enough to read as TEXT on the page, since
// labels render as coloured text in both the SVG tree and the grid. None is
// violet or amber, which mean a machine's and a contributor's unreviewed
// values in every app, and none is a red, which reads as an error. The teal is
// left out here: it is plaid-ui's `--primary` (174 37% 26%), which marks the
// arc being worked on.
const PRIMARY_DYE = '#2a5c57';
const AUTO_PALETTE = Object.freeze(CATEGORICAL.filter((c) => c !== PRIMARY_DYE));

// FNV-1a — stable across sessions/users so a given label always maps to the
// same palette slot (Math.imul keeps it in 32-bit range).
const hashString = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

// The common labels have fixed colours, so the ones that meet on one head
// tell apart: a verb's subject, object and oblique, a noun's modifiers.
// Function words and punctuation share the stone, which recedes. Every other
// label takes a dye by hash.
const [INDIGO, MADDER, , OLIVE, NAVY, GREEN, WALNUT, STONE] = CATEGORICAL;
const FIXED = Object.freeze({
  root: NAVY,
  nsubj: INDIGO,
  csubj: INDIGO,
  obj: MADDER,
  iobj: MADDER,
  obl: OLIVE,
  advmod: GREEN,
  amod: GREEN,
  nummod: GREEN,
  nmod: WALNUT,
  conj: WALNUT,
  acl: WALNUT,
  advcl: WALNUT,
  ccomp: WALNUT,
  xcomp: WALNUT,
  compound: MADDER,
  det: STONE,
  case: STONE,
  cc: STONE,
  mark: STONE,
  aux: STONE,
  cop: STONE,
  punct: STONE,
  NOUN: INDIGO,
  PROPN: INDIGO,
  VERB: MADDER,
  ADJ: GREEN,
  ADV: OLIVE,
  PRON: NAVY,
  NUM: WALNUT,
  DET: STONE,
  ADP: STONE,
  AUX: STONE,
  CCONJ: STONE,
  SCONJ: STONE,
  PART: STONE,
  PUNCT: STONE,
});

export const autoColor = (label) =>
  FIXED[label] || AUTO_PALETTE[hashString(label || '') % AUTO_PALETTE.length];

// Configured color (from a normalized {label: '#hex'} map) else the deterministic
// auto-color. Callers pass baseRel(value) for deprels.
export const resolveColor = (label, colorMap) => (colorMap && colorMap[label]) || autoColor(label);

// ---- config read / normalize (each takes a layer's `.config` object) ----

export const readVocab = (config, { fallback = [] } = {}) => {
  const v = readUdConfig(config, 'vocab');
  return Array.isArray(v) && v.length ? v : fallback;
};

// Read the stored colors — a plain {label: '#hex'} map — returning a fresh copy
// so callers can't mutate the layer config in place.
export const readColorMap = (config) => {
  const raw = readUdConfig(config, 'colors');
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
};

// Returns { list, map } — `list` is the array-of-{key,values} for the config UI,
// `map` is a key→values[] Map for the value picker.
export const readFeatureInventory = (config) => {
  const raw = readUdConfig(config, 'inventory');
  const list = Array.isArray(raw) && raw.length ? raw : UD_FEATURE_INVENTORY;
  const map = new Map();
  for (const entry of list) {
    if (entry && entry.key) map.set(entry.key, Array.isArray(entry.values) ? entry.values : []);
  }
  return { list, map };
};

// ---- config write payload shapes (define write-shape next to read-shape) ----

// Drop empty assignments before persisting a {label: '#hex'} map. Pass to setConfig.
export const cleanColorMap = (colorMap) =>
  Object.fromEntries(Object.entries(colorMap || {}).filter(([label, color]) => label && color));

// The feature inventory as stored: entries with a name, each value trimmed and
// the empty ones dropped.
const cleanInventory = (inventory) =>
  (inventory || [])
    .filter((e) => e.key.trim())
    .map((e) => ({
      key: e.key.trim(),
      values: (e.values || []).map((v) => v.trim()).filter(Boolean),
    }));

// Every vocabulary cell the settings tab writes, as `{bundle, entity, key,
// value}`, from its drafts: `{xposVocab, deprelVocab, uposVocab, deprelColors,
// uposColors, featureInventory, modes, descriptions}`. Mode and descriptions
// are sibling keys beside `vocab` (udVocabMode.js). Descriptions are stored
// only where they differ from what ships, so a project that never edited them
// stores nothing and follows the app's copy. A layer the project lacks writes
// nothing.
export const vocabCells = (info, drafts) => {
  const storedDescriptions = (map, shipped) =>
    cleanDescriptions(
      Object.fromEntries(
        Object.entries(map || {}).filter(([value, text]) => text !== (shipped?.[value] ?? '')),
      ),
    );
  const cells = [];
  const add = (bundle, entity, key, value) => entity && cells.push({ bundle, entity, key, value });
  const { modes, descriptions } = drafts;

  add('spanLayers', info.xposLayer, 'vocab', drafts.xposVocab);
  add('spanLayers', info.xposLayer, 'vocabMode', modes.xpos || MODES.OPEN);
  add('spanLayers', info.xposLayer, 'vocabDescriptions', storedDescriptions(descriptions.xpos));

  add('relationLayers', info.relationLayer, 'vocab', drafts.deprelVocab);
  add('relationLayers', info.relationLayer, 'colors', cleanColorMap(drafts.deprelColors));
  add('relationLayers', info.relationLayer, 'vocabMode', modes.deprel || MODES.OPEN);
  add(
    'relationLayers',
    info.relationLayer,
    'vocabDescriptions',
    storedDescriptions(descriptions.deprel, DEPREL_DESCRIPTIONS),
  );

  add('spanLayers', info.uposLayer, 'vocab', drafts.uposVocab);
  add('spanLayers', info.uposLayer, 'colors', cleanColorMap(drafts.uposColors));
  add('spanLayers', info.uposLayer, 'vocabMode', modes.upos || MODES.OPEN);
  add(
    'spanLayers',
    info.uposLayer,
    'vocabDescriptions',
    storedDescriptions(descriptions.upos, UPOS_DESCRIPTIONS),
  );

  add('spanLayers', info.featuresLayer, 'inventory', cleanInventory(drafts.featureInventory));
  add('spanLayers', info.featuresLayer, 'vocabMode', modes.feats || MODES.OPEN);
  add(
    'spanLayers',
    info.featuresLayer,
    'vocabDescriptions',
    storedDescriptions(descriptions.feats),
  );
  return cells;
};

// The one cell that adds a vocabulary's off-list values to its list, as
// `{bundle, entity, key, value}`: the feature inventory with `field.features`'
// values merged in by name (`[{key, values: [{value}]}]`), or the list of a
// plain or relation vocabulary (`field.key`, read from `info.vocab`) with
// `field.values` added after it.
export const withAddedValues = (info, field) => {
  const entity = info[field.layer];
  if (field.kind === 'feats') {
    const inventory = info.vocab.featureInventory.list.map((e) => ({
      key: e.key,
      values: [...(e.values || [])],
    }));
    const byKey = new Map(inventory.map((e) => [e.key, e]));
    for (const entry of field.features) {
      const add = entry.values.map((v) => v.value);
      if (byKey.has(entry.key)) {
        const existing = byKey.get(entry.key);
        existing.values = [...new Set([...existing.values, ...add])];
      } else {
        inventory.push({ key: entry.key, values: add });
      }
    }
    return { bundle: 'spanLayers', entity, key: 'inventory', value: inventory };
  }
  const value = [
    ...new Set([...(info.vocab[field.key] || []), ...field.values.map((v) => v.value)]),
  ];
  const bundle = field.kind === 'relation' ? 'relationLayers' : 'spanLayers';
  return { bundle, entity, key: 'vocab', value };
};
