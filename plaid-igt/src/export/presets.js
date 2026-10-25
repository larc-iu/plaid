// Named export presets, persisted per project at config.igt.export.presets
// (see plaid-igt CLAUDE.md for the igt config namespace conventions). The
// run-time scope (whole project / selected docs / this doc) is deliberately
// NOT part of a preset.

import { statusOf } from '@ui/lib/errors.js';
import { withStoredConfig } from '@ui/domain/configCells.js';
import { uuidv4 } from '@larc-iu/plaid-client';
import { IGT_NAMESPACE, SENTENCE_ROLES } from '../domain/igtConfig.js';
import { ENTRY_ROLES } from '../domain/vocabFields.js';
import { defaultCldfOptions } from './cldf.js';
import { defaultElanOptions } from './elan.js';
import { defaultLatexOptions } from './latexBook.js';
import { isLangTag, parseFieldName } from '../domain/fieldNames.js';

// Each export format and what the export does with it. Policy lives here, so
// a new format is one entry and runExport, newPreset, the preset editor and
// the runner read the same facts:
//
// - alwaysZip: a zip at every scope, even one document.
// - media: the preset's includeMedia option applies, so the recordings go in.
// - vocabularyTsvs: runExport adds the vocabularies as TSV files to a zip when
//   the preset's includeVocabularies is set, and the preset editor offers that
//   switch.
// - archive: the lossless archive, which reads every layer, the guidelines
//   and the comments, and exports a project with no documents.
// - keepsMediaName: a recording goes out under the name the document's Media
//   file field keeps.
// - dataset: the documents are assembled once, at the end, from all of them.
// - bareType: the content type of a lone document's bare file.
// - zipNote: what the runner says about the zip.
// - options(layers, languages): a new preset's options.
const plainTextOptions = (layers) => ({
  orthographies: [...layers.orthographies],
  wordFields: [...layers.wordFields],
  morphFields: [...layers.morphFields],
  sentFields: [...layers.sentFields],
  wordLine: 'segmented',
  numberSentences: true,
  includeHeader: true,
});

const FORMAT_DEFAULTS = {
  alwaysZip: false,
  media: false,
  vocabularyTsvs: false,
  archive: false,
  keepsMediaName: false,
  dataset: false,
  bareType: 'text/plain;charset=utf-8',
  zipNote: null,
};

export const EXPORT_FORMATS = [
  {
    ...FORMAT_DEFAULTS,
    id: 'plaintext',
    label: 'Plain text',
    ext: 'txt',
    defaultName: 'Plain text',
    vocabularyTsvs: true,
    options: plainTextOptions,
  },
  {
    ...FORMAT_DEFAULTS,
    id: 'flextext',
    label: 'FLEx (.flextext + .lift)',
    ext: 'flextext',
    defaultName: 'FLEx',
    zipNote:
      'This format produces one .flextext for the whole run. With the lexicon included (set in the ' +
      'preset) it becomes a .zip pairing that file with the lexicon as LIFT.',
    options: (layers, languages) => ({
      langs: {
        // The writing-system tag is the fact itself; the ISO code and the
        // name are guesses at it, in that order.
        baseline:
          languages?.object?.tag ||
          languages?.object?.iso639P3 ||
          tagify(languages?.object?.name) ||
          'und',
        analysis:
          languages?.meta?.tag ||
          languages?.meta?.iso639P3 ||
          tagify(languages?.meta?.name) ||
          'en',
        orthographies: Object.fromEntries(layers.orthographies.map((n) => [n, tagify(n) || 'und'])),
        fieldOverrides: {},
      },
      fieldMap: defaultFieldMap(layers),
      metadataMap: proposeMetadataMap(layers.documentMetadata),
      citationForms: true,
      lexicon: true,
    }),
  },
  {
    ...FORMAT_DEFAULTS,
    id: 'cldf',
    label: 'CLDF TextCorpus (.zip dataset)',
    ext: 'csv',
    defaultName: 'CLDF',
    alwaysZip: true,
    media: true,
    dataset: true,
    zipNote:
      'This format always produces a .zip dataset (one CSV per CLDF component table) whatever the ' +
      'scope. Whether the lexicon is included is set in the preset.',
    // The dataset always carries the vocabularies it needs for EntryTable, so
    // the TSV flag does not apply. Languages come from project config at run
    // time rather than being frozen into the preset.
    options: (layers) => ({ ...defaultCldfOptions(layers), includeMedia: true }),
  },
  {
    ...FORMAT_DEFAULTS,
    id: 'elan',
    label: 'ELAN annotation file (.eaf)',
    ext: 'eaf',
    defaultName: 'ELAN',
    media: true,
    vocabularyTsvs: true,
    keepsMediaName: true,
    bareType: 'text/xml;charset=utf-8',
    // Media rides along in the zip so the .eaf's MEDIA_URL resolves next to it.
    options: (layers) => ({ ...defaultElanOptions(layers), includeMedia: true }),
  },
  {
    ...FORMAT_DEFAULTS,
    id: 'latex',
    label: 'LaTeX book (.zip)',
    ext: 'tex',
    defaultName: 'LaTeX',
    alwaysZip: true,
    zipNote:
      'This format always produces a .zip of LaTeX source, one chapter per document, whatever the ' +
      'scope.',
    // A book of every document in the run, so the TSV flag does not apply.
    options: (layers) => defaultLatexOptions(layers),
  },
  {
    ...FORMAT_DEFAULTS,
    id: 'plaid-igt-json',
    label: 'Plaid IGT JSON (lossless .zip archive)',
    ext: 'json',
    defaultName: 'Plaid IGT JSON',
    alwaysZip: true,
    media: true,
    archive: true,
    zipNote:
      'This format always produces a .zip archive including all vocabularies and the project ' +
      'configuration, whatever the scope.',
    // Lossless archive: vocabularies are always included (runExport forces
    // this regardless of the flag); the only option is media embedding.
    options: () => ({ includeMedia: true }),
  },
];

/** A format's entry, and plain text's for an id no entry has. */
export const exportFormat = (format) =>
  EXPORT_FORMATS.find((f) => f.id === format) ?? EXPORT_FORMATS[0];

export const formatExt = (format) => EXPORT_FORMATS.find((f) => f.id === format)?.ext ?? 'txt';

/**
 * The name to pre-fill when creating a preset in this format.
 *
 * The first preset of a format can just be called after the format, which is
 * what people name them anyway. Once one exists the generic name is taken and
 * would only invite duplicates called "ELAN" and "ELAN", so the field is left
 * empty and the user has to say what makes this one different.
 */
export const suggestPresetName = (format, presets = []) =>
  presets.some((p) => p.format === format)
    ? ''
    : (EXPORT_FORMATS.find((f) => f.id === format)?.defaultName ?? '');

export const readExportPresets = (project) => {
  const presets = project?.config?.[IGT_NAMESPACE]?.export?.presets;
  return Array.isArray(presets) ? presets : [];
};

/**
 * Change a project's preset list by `change(list)`, which returns the list to
 * store. The write expects the list as `project` holds it. When another save
 * came in between, the list is read again and `change` made to it once more,
 * so a preset someone else added or edited meanwhile stays. `change` throws to
 * refuse (a preset it edits was changed or removed meanwhile). Resolves to the
 * project with the list as stored, and the list.
 */
export async function updateExportPresets(client, project, change) {
  const attempt = async (p) => {
    const presets = change(readExportPresets(p));
    await client.projects.setConfig(p.id, IGT_NAMESPACE, 'export', { presets }, undefined, {
      expected: p.config?.[IGT_NAMESPACE]?.export,
    });
    return { project: applyExportPresets(p, presets), presets };
  };
  try {
    return await attempt(project);
  } catch (err) {
    if (statusOf(err) !== 409) throw err;
    return attempt(await client.projects.get(project.id));
  }
}

/**
 * The same write applied to a project object in hand, so a page that holds one
 * does not have to refetch it (or know where presets live) to stay in step with
 * what it just saved.
 */
export const applyExportPresets = (project, presets) =>
  withStoredConfig(project, IGT_NAMESPACE, 'export', { presets });

// Sanitize a language tag-ish string: keep letters/digits/hyphens.
const tagify = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '')
    .slice(0, 30);

// Pre-fill the flextext field→item-type mapping from the fields' stored roles
// (`layers.fieldRoles`, see exportLayers.js), the exact inverse of the FLEx
// importer's: a sentence field holding the translation is gls, the literal
// translation lit, and any other sentence field a note. A word or morpheme
// field whose Lexicon field holds the gloss role is gls, the part-of-speech
// role pos (msa on a morpheme). Never a field's name. Unmapped fields are
// omitted from the output.
export function defaultFieldMap(layers) {
  const roles = layers.fieldRoles || {};
  const sentence = {};
  for (const f of layers.sentFields) {
    const role = roles[`Sentence:${f}`];
    if (role === SENTENCE_ROLES.LITERAL_TRANSLATION) sentence[f] = 'lit';
    else if (role === SENTENCE_ROLES.TRANSLATION) sentence[f] = 'gls';
    else sentence[f] = 'note';
  }
  const word = {};
  for (const f of layers.wordFields) {
    const role = roles[`Word:${f}`];
    if (role === ENTRY_ROLES.GLOSS) word[f] = 'gls';
    else if (role === ENTRY_ROLES.POS) word[f] = 'pos';
  }
  const morpheme = {};
  for (const f of layers.morphFields) {
    const role = roles[`Morpheme:${f}`];
    if (role === ENTRY_ROLES.GLOSS) morpheme[f] = 'gls';
    else if (role === ENTRY_ROLES.POS) morpheme[f] = 'msa';
  }
  return { sentence, word, morpheme };
}

// The FLEx text fields a document metadata field's name proposes, the inverse
// of the FLEx importer's naming. Proposed once, when a preset is made or a
// preset without a mapping is first opened, and stored on the preset.
const METADATA_TYPE_BY_NAME = {
  title: 'title',
  abbreviation: 'title-abbreviation',
  source: 'source',
  description: 'comment',
};

/**
 * The .flextext `metadataMap` a set of document metadata field names
 * proposes: `{field: {type, lang?}}` for each field whose name, without its
 * language suffix, is Title, Abbreviation, Source or Description, with the
 * language its suffix names. Every other field is left out (a comment).
 */
export function proposeMetadataMap(names) {
  const out = {};
  for (const name of names || []) {
    const { base, ws } = parseFieldName(name);
    const type = METADATA_TYPE_BY_NAME[base.trim().toLowerCase()];
    if (!type) continue;
    out[name] = { type, ...(ws && isLangTag(ws) ? { lang: ws } : {}) };
  }
  return out;
}

/**
 * A fresh preset with everything selected and heuristic defaults. `languages`
 * is the project's configured {object, meta} identity (see readLanguages); it
 * seeds the .flextext writing-system tags so the same fact is not typed twice.
 */
export function newPreset(format, layers, name = 'New preset', languages = null) {
  return {
    id: uuidv4(),
    name,
    format,
    includeVocabularies: exportFormat(format).archive,
    options: exportFormat(format).options(layers, languages),
  };
}
