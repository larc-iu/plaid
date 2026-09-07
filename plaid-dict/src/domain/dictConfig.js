// The dictionary's own publication record. A vocabulary carries its entries;
// everything a reader needs around them — what the dictionary is called, where
// it lives, who made it, how to cite it — lives in the vocabulary's config
// under the `dict` namespace, which this app owns. (`plaid` is reserved for
// cross-app conventions, `igt` belongs to plaid-igt.)
//
//   config.dict = {
//     title:     "Sena Dictionary",
//     slug:      "sena",                        // the URL segment
//     languages: { object: {...}, meta: {...} }, // same shape as config.igt.languages
//     credits:   "Compiled by ...",
//     citation:  "Cite as ...",
//     about:     "...",                          // the front page body
//     exampleLayers: ["Translation", ...],       // sentence layers under an example
//     alphabet:  ["a", "b", "bv", "c", "ch", ...], // the dictionary's own order
//   }
//
// A vocabulary with no `config.dict` is not a dictionary: it is not listed here
// and has no page. Language identity has to live in this record because a
// vocabulary is cross-project and cannot borrow any one project's.

import { alphabetCollator } from './collation.js';

export const DICT_NAMESPACE = 'dict';

/** The keys of the record, in the order the setup form writes them. */
export const DICT_KEYS = [
  'title',
  'slug',
  'languages',
  'credits',
  'citation',
  'about',
  'exampleLayers',
  'alphabet',
];

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const EMPTY_LANGUAGE = Object.freeze({
  name: '',
  glottocode: '',
  iso639P3: '',
  latitude: null,
  longitude: null,
});

const normalizeLanguage = (lang) => ({
  name: str(lang?.name),
  glottocode: str(lang?.glottocode),
  iso639P3: str(lang?.iso639P3),
  latitude: num(lang?.latitude),
  longitude: num(lang?.longitude),
});

/** The raw record on a vocabulary's config, or null. */
export const readDict = (config) => config?.[DICT_NAMESPACE] ?? null;

/** The record, fully shaped, for a vocabulary that has one. */
export const readDictRecord = (config) => {
  const raw = readDict(config);
  if (!raw) return null;
  return {
    title: str(raw.title),
    slug: str(raw.slug),
    languages: {
      object: normalizeLanguage(raw.languages?.object),
      meta: normalizeLanguage(raw.languages?.meta),
    },
    credits: str(raw.credits),
    citation: str(raw.citation),
    about: str(raw.about),
    // null means the dictionary has not chosen, and every sentence layer with a
    // value is shown. An empty list is a choice: show none of them.
    exampleLayers: Array.isArray(raw.exampleLayers)
      ? raw.exampleLayers.map(str).filter(Boolean)
      : null,
    // Empty means the dictionary states no alphabet and the locale's collator
    // decides, which knows nothing about n-graphs.
    alphabet: Array.isArray(raw.alphabet) ? raw.alphabet.map(str).filter(Boolean) : [],
  };
};

/** A vocabulary is a dictionary once its record has a slug to reach it by. */
export const isDictionary = (vocab) => !!readDictRecord(vocab?.config)?.slug;

/** The name a dictionary goes by: its own title, else the vocabulary's name. */
export const dictTitle = (vocab) => readDictRecord(vocab?.config)?.title || vocab?.name || '';

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A name turned into a candidate slug: "Sena Dictionary" -> "sena-dictionary". */
export const slugify = (name) =>
  String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/**
 * What is wrong with a draft record, as `{field: message}`. Empty means it can
 * be saved. `taken` is the slugs already in use by OTHER vocabularies; the
 * check is best effort (it only sees what this user can read) and becomes a
 * real constraint only if the public routes are ever built.
 */
export const validateSetup = (draft, taken = []) => {
  const errors = {};
  if (!str(draft.title)) errors.title = 'Required.';
  const slug = str(draft.slug);
  if (!slug) errors.slug = 'Required.';
  else if (!SLUG_PATTERN.test(slug)) errors.slug = 'Lowercase letters, digits and hyphens.';
  else if (taken.includes(slug)) errors.slug = 'Already used by another dictionary.';
  return errors;
};

/**
 * Write the record onto a vocabulary, one config key per call, all under one
 * operation so the audit log shows a single setup. A key whose value is empty
 * is removed rather than stored blank.
 */
export const saveDictRecord = async (client, vocabularyId, draft, { label } = {}) => {
  const record = {
    title: str(draft.title),
    slug: str(draft.slug),
    languages: {
      object: normalizeLanguage(draft.languages?.object),
      meta: normalizeLanguage(draft.languages?.meta),
    },
    credits: str(draft.credits),
    citation: str(draft.citation),
    about: str(draft.about),
    exampleLayers: Array.isArray(draft.exampleLayers)
      ? draft.exampleLayers.map(str).filter(Boolean)
      : [],
    alphabet: Array.isArray(draft.alphabet) ? draft.alphabet.map(str).filter(Boolean) : [],
  };
  await client.withOperation(label || `Set up dictionary "${record.title}"`, async () => {
    for (const key of DICT_KEYS) {
      const value = record[key];
      const empty = typeof value === 'string' && value === '';
      if (empty) await client.vocabLayers.deleteConfig(vocabularyId, DICT_NAMESPACE, key);
      else await client.vocabLayers.setConfig(vocabularyId, DICT_NAMESPACE, key, value);
    }
  });
  return record;
};

/**
 * The collator a dictionary sorts by. A stated alphabet wins, since it is the
 * only thing that knows an n-graph is one letter. Otherwise the object
 * language's ISO 639-3 code, and failing that the browser's default.
 */
export const dictCollator = (record) => {
  if (record?.alphabet?.length) return alphabetCollator(record.alphabet);
  return localeCollator(record?.languages?.object?.iso639P3);
};

/** The locale collator alone, which is also what the setup form suggests from. */
export const localeCollator = (tag) => {
  if (tag && /^[a-z]{2,3}$/i.test(tag)) {
    try {
      return new Intl.Collator(tag, { numeric: true });
    } catch {
      /* not a tag any ICU build knows */
    }
  }
  return new Intl.Collator(undefined, { numeric: true });
};
