// Project-declared metadata fields, and the rules for what may be one.
//
// A treebank carries notes at two levels, and CoNLL-U has a line for each:
// document-level facts (`# newdoc id`, source, genre, licence) and
// sentence-level ones (`# sent_id`, a free translation, a comment). Plaid
// stores them as ordinary entity metadata — the document's own for the first,
// the sentence TOKEN's for the second — and `ConlluDocument.toConllu` has
// always round-tripped the sentence half. What was missing was any way to see
// or edit them.
//
// Which fields a project offers is the project's own choice, declared under the
// `ud` namespace as `[{name}]`. The object form is IGT's (`{name, tagset?}`)
// and is kept so item 8 can add a tagset or a description to a field without
// rewriting what is stored.

import { isProvKey } from './provenanceUi.js';

export const DOCUMENT_METADATA_KEY = 'documentMetadata';
export const SENTENCE_METADATA_KEY = 'sentenceMetadata';

/**
 * Every sentence carries this whether the project declares it or not: it is
 * CoNLL-U's own identifier for a sentence, the exporter already emits it, and
 * an import already round-trips it onto the sentence token.
 */
export const SENT_ID = 'sent_id';

/**
 * Keys a field may not claim, per level. `text` is derived from the document
 * body by the exporter, so a field that wrote it could silently desync the
 * `# text` line from the text it describes.
 */
const RESERVED = {
  document: new Set(),
  sentence: new Set([SENT_ID, 'text']),
};

/** The declared field names for a level, in the order the project set. */
export function readMetadataFields(config, level) {
  const key = level === 'sentence' ? SENTENCE_METADATA_KEY : DOCUMENT_METADATA_KEY;
  const raw = config?.ud?.[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((field) => (typeof field === 'string' ? field : field?.name))
    .filter((name) => typeof name === 'string' && name.trim() !== '');
}

/** Names back to what is stored. */
export const toMetadataConfig = (names) => (names || []).map((name) => ({ name: name.trim() }));

/**
 * Why this name cannot be a field, or null when it can. `taken` is the names
 * already declared at this level.
 */
export function metadataFieldError(name, level, taken = []) {
  const trimmed = (name || '').trim();
  if (!trimmed) return 'A field needs a name.';
  // The query engine reads a dot as a path separator, so a key containing one
  // is unreachable from a query for the rest of its life.
  if (trimmed.includes('.')) return 'A field name cannot contain a dot.';
  if (isProvKey(trimmed)) return `${trimmed} is reserved for provenance.`;
  if (RESERVED[level]?.has(trimmed)) {
    return trimmed === SENT_ID
      ? 'Every sentence already has sent_id.'
      : `${trimmed} is written from the document text.`;
  }
  if (taken.some((t) => t.trim() === trimmed)) return `${trimmed} is already a field.`;
  return null;
}

/**
 * The metadata a level's editor should show: the declared fields, plus any key
 * already stored on the entity that nobody declared. A field removed from the
 * project, or one that arrived with an import, still holds a value, and hiding
 * it would make it invisible and un-deletable while it kept exporting.
 * Provenance keys are never content, and `sent_id` leads the sentence list.
 */
export function metadataRows(declared, stored, level) {
  const names = [];
  if (level === 'sentence') names.push(SENT_ID);
  for (const name of declared) if (!names.includes(name)) names.push(name);
  const extra = Object.keys(stored || {})
    .filter((key) => !isProvKey(key) && !names.includes(key))
    .filter((key) => !(level === 'sentence' && key === 'text'))
    .sort();
  return [
    ...names.map((name) => ({ name, declared: true })),
    ...extra.map((name) => ({ name, declared: false })),
  ];
}
