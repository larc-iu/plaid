// CLDF import engine — turns buildCldfDocuments() output into plaid API writes.
//
// Same division of labour as the FLEx and native engines: layer and vocabulary
// CREATION is the setup executor's job (the flow pre-fills the wizard from
// deriveSetupData and runs the normal setup), and this engine runs AFTER setup
// against the resolved project.
//
// Lexicon items are stamped with their CLDF entry id at creation, as
// provenance back to the source dataset.

import { documentProgress } from '../progress.js';
import { ImportCancelled } from '../stamps.js';
import { ENTRY_ROLES, isReservedFieldName } from '../../domain/vocabFields.js';
import { recordProjectLanguages } from '../projectLanguages.js';
import {
  createDocumentShell,
  finishDocument,
  resolveIgtTargets,
  setupDataFor,
  writeBuiltDocument,
} from '../project.js';
import { createEntriesOnce, mergeFieldSchema, placeSenses } from '../lexicon.js';
import { sameName } from '@ui/lib/nameKey.js';

// The entry keys the importer itself fills from CLDF's own columns, and the
// role each holds. Any other column becomes a field without one.
const COLUMN_ROLES = {
  gloss: ENTRY_ROLES.GLOSS,
  definition: ENTRY_ROLES.DEFINITION,
  pos: ENTRY_ROLES.POS,
};

const ITEM_SOURCE_KEY = 'cldfEntry';

/** The setup-wizard input derived from a build. */
/**
 * The vocabularies a lexicon names, in first-seen order; an entry that names
 * none goes under the default. Empty when there is no lexicon at all.
 */
const lexiconNames = (lexicon, fallback = 'Lexicon') => {
  if (!lexicon?.length) return [];
  const names = [];
  for (const e of lexicon) {
    const name = e.vocabulary || fallback;
    if (!names.includes(name)) names.push(name);
  }
  return names;
};

const META_LANGUAGE_FIELDS = new Set(['Gloss', 'Translation', 'Note']);

export function deriveSetupData(build, projectName, { vocabularyName = 'Lexicon' } = {}) {
  return setupDataFor({
    projectName,
    orthographies: build.schema.orthographies,
    // The gloss, translation and comment fields are in the dataset's meta
    // language by the format's own definition. A dataset translated into
    // several has each translation named after its language, and the build
    // says which. Recorded, so the FLEx export tags them without anyone
    // typing the code. A custom column's language is not known.
    // A field bound to Translated_Text or Comment says what it holds.
    fields: build.schema.fields.map((f) => ({
      name: f.name,
      scope: f.scope,
      lang:
        f.lang ??
        (META_LANGUAGE_FIELDS.has(f.name) ? build.languages?.meta?.iso639P3 || null : null),
      ...(f.sentenceRole ? { sentenceRole: f.sentenceRole } : {}),
    })),
    // A dataset says nothing about which words to skip, so the project gets
    // the rule every new project starts with, the one the build assumed.
    // One vocabulary per name the dataset gives its entries (our own export
    // writes a Vocabulary column), else one under the default name.
    vocabularies: lexiconNames(build.lexicon, vocabularyName).map((name, i) => ({
      id: i === 0 ? 'new-cldf-lexicon' : `new-cldf-lexicon-${i + 1}`,
      name,
    })),
    documentMetadata: build.schema.documentMetadata.map((m) => m.name),
  });
}

/** Resolve engine write targets. Throws when setup did not produce them. */
export function resolveTargets(project, build) {
  return resolveIgtTargets(project, build.schema.fields);
}

/**
 * Import the lexicon as vocabulary items. Returns Map<cldfEntryId, itemId>.
 *
 * A CLDF entry with more than one sense becomes a headword with its senses
 * under it, as the FLEx import does; with one sense, the sense IS the entry.
 */
export async function importLexicon({ client, vocabId, lexicon, onProgress, shouldStop }) {
  const check = () => {
    if (shouldStop?.()) throw new ImportCancelled();
  };
  const existing = await client.vocabLayers.get(vocabId, true);
  const byEntry = new Map();

  // What to create, headword before its senses, and where each sense belongs.
  const pending = [];
  const places = [];
  const senseKey = (entry, sense) => `${entry.id}/${sense.id}`;
  for (const entry of lexicon) {
    const split = (entry.senses?.length ?? 0) > 1;
    if (split) {
      for (const [i, sense] of entry.senses.entries()) {
        places.push({ key: senseKey(entry, sense), parentKey: entry.id, senseOrder: i + 1 });
      }
    }
    const metadata = { ...entry.metadata };
    if (split) {
      // The senses hold these now, one meaning each.
      delete metadata.gloss;
      delete metadata.definition;
    } else {
      // One sense is the entry's own meaning, so what its row carried (its
      // part of speech, its definition, its own fields) belongs on the entry
      // rather than being dropped with the row. The entry's own values win.
      const only = entry.senses?.[0];
      if (only) Object.assign(metadata, { ...(only.metadata || {}), ...metadata });
    }
    pending.push({ key: entry.id, form: entry.form, metadata });
    if (!split) continue;
    for (const sense of entry.senses) {
      pending.push({
        key: senseKey(entry, sense),
        form: entry.form,
        metadata: {
          ...(sense.metadata || {}),
          // A sense row with a definition and no gloss carries the definition
          // as its description (the column is required); it is a definition
          // still, not a gloss.
          ...(sense.description ? { gloss: sense.description } : {}),
        },
      });
    }
  }
  // The field schema is the union of what the items actually carry, with the
  // settled core fields always present.
  // A reserved key is structure, never a field: `homograph` rides in on an
  // entry's metadata and would otherwise be declared as one, which the UI
  // forbids creating by hand and the exporter would write out a second time
  // as its own column.
  const fieldKeys = new Set(['gloss', 'pos', 'definition', 'morphType']);
  const addKey = (k) => {
    if (!isReservedFieldName(k)) fieldKeys.add(k);
  };
  for (const entry of lexicon) {
    for (const k of Object.keys(entry.metadata)) addKey(k);
    // A sense carries fields of its own, which the schema has to declare too.
    for (const sense of entry.senses || []) {
      for (const k of Object.keys(sense.metadata || {})) addKey(k);
    }
  }

  await createEntriesOnce({
    client,
    vocabId,
    entries: pending.map((p) => ({ ...p, metadata: { ...p.metadata, [ITEM_SOURCE_KEY]: p.key } })),
    known: byEntry,
    check,
    onProgress: (done, total) => onProgress?.({ phase: 'lexicon', done, total }),
  });

  // The tree, once every item has an id.
  await placeSenses({
    client,
    existing,
    places: places
      .filter((p) => byEntry.has(p.key) && byEntry.has(p.parentKey))
      .map((p) => ({
        id: byEntry.get(p.key),
        parent: byEntry.get(p.parentKey),
        senseOrder: p.senseOrder,
      })),
    check,
  });

  // The vocab's field schema drives the management table and the item modal.
  // Project setup puts the Status field there when it makes the vocabulary.
  await mergeFieldSchema({
    client,
    vocabId,
    existing,
    keys: fieldKeys,
    declare: (name) => ({
      // name-ok: proposal at creation, a new field only
      inline: name === 'gloss' || name === 'pos',
      // The keys the dataset's own columns fill (a sense's Description, its
      // Definition, a Part of Speech) say what they hold.
      ...(COLUMN_ROLES[name] ? { role: COLUMN_ROLES[name] } : {}),
    }),
  });
  return byEntry;
}
// The steps one document goes through, in order, so progress can report how
// far into a document it is and not just which document.
const DOCUMENT_STEPS = [
  'Creating document',
  'Creating text',
  'Creating sentences',
  'Creating words',
  'Creating morphemes',
  'Creating annotations',
  'Uploading media',
];

/** Import one document: text, sentence partition, words, morphemes, spans. */
async function importDocument({
  client,
  projectId,
  targets,
  doc,
  index = 0,
  total = 1,
  onProgress,
  shouldStop,
  warnings,
}) {
  const progress = documentProgress({
    onProgress,
    doc: doc.name,
    index,
    total,
    steps: DOCUMENT_STEPS,
  });
  const check = () => {
    if (shouldStop?.()) throw new ImportCancelled();
  };

  const {
    documentId: docId,
    textId,
    sentenceIds,
  } = await createDocumentShell({
    client,
    projectId,
    targets,
    name: doc.name,
    metadata: doc.metadata,
    body: doc.body,
    tokenEdges: doc.tokenEdges,
    sentences: doc.sentences,
    progress,
    check,
  });

  if (textId) {
    await writeBuiltDocument({ client, targets, textId, sentenceIds, doc, check, progress });
  }

  await finishDocument({
    client,
    documentId: docId,
    name: doc.name,
    media: doc.mediaBytes ? new File([doc.mediaBytes], doc.mediaName || 'media') : null,
    prepare: true,
    onProgress,
    progress,
    check,
    warnings,
  });
  return docId;
}

/**
 * Run a full import against a set-up project. The whole import is ONE logical
 * operation in the audit log; each write keeps its own description underneath.
 */
export async function runCldfImport(args) {
  return args.client.withOperation('Import CLDF dataset', () => runCldfImportImpl(args), {
    kind: 'import',
    ref: 'format:cldf',
  });
}

async function runCldfImportImpl({ client, projectId, build, onProgress, shouldStop }) {
  const project = await client.projects.get(projectId);
  const targets = resolveTargets(project, build);
  const warnings = [...build.warnings];

  // The dataset's LanguageTable is where the project's language identity comes
  // from, and it knows more than a tag: a name, a Glottocode and coordinates.
  await recordProjectLanguages(client, project, build.languages);

  if (build.lexicon.length) {
    // Each vocabulary the dataset names, into the project vocabulary of that
    // name; with one lexicon and one vocabulary, whatever that vocabulary is
    // called.
    const vocabs = project.vocabs || [];
    const names = lexiconNames(build.lexicon);
    for (const name of names) {
      const vocab =
        names.length === 1 && vocabs.length === 1
          ? vocabs[0]
          : vocabs.find((v) => sameName(v.name, name));
      if (!vocab) {
        warnings.push(
          `No project vocabulary named "${name}" was created, so its entries were skipped.`,
        );
        continue;
      }
      await importLexicon({
        client,
        vocabId: vocab.id,
        lexicon: build.lexicon.filter((e) => (e.vocabulary || 'Lexicon') === name),
        onProgress,
        shouldStop,
      });
    }
  }

  const results = { imported: 0 };
  for (let i = 0; i < build.documents.length; i += 1) {
    if (shouldStop?.()) throw new ImportCancelled();
    const doc = build.documents[i];
    onProgress?.({
      phase: 'document',
      doc: doc.name,
      index: i,
      total: build.documents.length,
      step: 'Starting',
    });
    await importDocument({
      client,
      projectId,
      targets,
      doc,
      index: i,
      total: build.documents.length,
      onProgress,
      shouldStop,
      warnings,
    });
    warnings.push(...doc.warnings);
    results.imported += 1;
  }
  onProgress?.({ phase: 'done', ...results });
  return { ...results, warnings };
}
