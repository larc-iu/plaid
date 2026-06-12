// Named export presets, persisted per project at config.igt.export.presets
// (see plaid-igt CLAUDE.md for the igt config namespace conventions). The
// run-time scope (whole project / selected docs / this doc) is deliberately
// NOT part of a preset.

import { IGT_NAMESPACE } from '../domain/igtConfig.js';

export const EXPORT_FORMATS = [
  { id: 'plaintext', label: 'Plain text', ext: 'txt' },
  { id: 'flextext', label: 'FLEx interlinear (.flextext)', ext: 'flextext' },
  { id: 'plaid-igt-json', label: 'Plaid IGT JSON (lossless .zip archive)', ext: 'json' },
];

export const formatExt = (format) =>
  EXPORT_FORMATS.find((f) => f.id === format)?.ext ?? 'txt';

export const readExportPresets = (project) => {
  const presets = project?.config?.[IGT_NAMESPACE]?.export?.presets;
  return Array.isArray(presets) ? presets : [];
};

export async function writeExportPresets(client, projectId, presets) {
  await client.projects.setConfig(projectId, IGT_NAMESPACE, 'export', { presets });
}

// Sanitize a language tag-ish string: keep letters/digits/hyphens.
const tagify = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 30);

// Pre-fill the flextext field→item-type mapping from field names — the exact
// inverse of the FLEx importer's naming (Translation / Literal Translation /
// Note, Gloss, POS). Unmapped fields are omitted from the output.
export function defaultFieldMap(layers) {
  const sentence = {};
  for (const f of layers.sentFields) {
    if (/literal/i.test(f)) sentence[f] = 'lit';
    else if (/translation|gls|gloss/i.test(f)) sentence[f] = 'gls';
    else sentence[f] = 'note';
  }
  const word = {};
  for (const f of layers.wordFields) {
    if (/gloss/i.test(f)) word[f] = 'gls';
    else if (/pos|category/i.test(f)) word[f] = 'pos';
  }
  const morpheme = {};
  for (const f of layers.morphFields) {
    if (/gloss/i.test(f)) morpheme[f] = 'gls';
    else if (/pos|category|msa/i.test(f)) morpheme[f] = 'msa';
  }
  return { sentence, word, morpheme };
}

/** A fresh preset with everything selected and heuristic defaults. */
export function newPreset(format, layers, name = 'New preset') {
  const base = { id: crypto.randomUUID(), name, format, includeVocabularies: false };
  if (format === 'plaid-igt-json') {
    // Lossless archive: vocabularies are always included (runExport forces
    // this regardless of the flag); the only option is media embedding.
    return { ...base, includeVocabularies: true, options: { includeMedia: true } };
  }
  if (format === 'flextext') {
    return {
      ...base,
      options: {
        langs: {
          baseline: 'und',
          analysis: 'en',
          orthographies: Object.fromEntries(
            layers.orthographies.map((n) => [n, tagify(n) || 'und'])),
          fieldOverrides: {},
        },
        fieldMap: defaultFieldMap(layers),
        citationForms: true,
      },
    };
  }
  return {
    ...base,
    options: {
      orthographies: [...layers.orthographies],
      wordFields: [...layers.wordFields],
      morphFields: [...layers.morphFields],
      sentFields: [...layers.sentFields],
      segmentMorphemes: true,
      numberSentences: true,
      includeHeader: true,
    },
  };
}
