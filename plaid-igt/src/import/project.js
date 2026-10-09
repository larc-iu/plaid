// The part of an importer that is not about its format.
//
// Four importers make a project from a file (FLEx, CLDF, ELAN, the archive).
// Around their own readers each one does the same three things, and each one
// used to do them in its own words:
//
//   setupDataFor        what it read, as the setup wizard's input, so the
//                       normal project setup makes the layers and vocabularies
//   resolveIgtTargets   the layers setup made, as the ids the engine writes to
//   createDocumentShell the document row, its baseline text, and the sentence
//                       partition over it
//
// They live here so a project-level fact learned by one importer is learned by
// all four, and so the rules under them — what `lang` means on a field, what
// "setup incomplete" reads like, why the sentence partition cannot be chunked
// — have one home. The format-shaped work (reading the file, naming fields,
// glosses, lexicons, media) stays in each importer.

import { createdIds, uuidv7 } from '@larc-iu/plaid-client';
import {
  defaultIgnoredTokensSetup,
  findAlignmentTokenLayer,
  findBaselineTextLayer,
  findMorphemeTokenLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
  readScope,
} from '../domain/igtConfig.js';

/**
 * The setup-wizard input an importer implies, in the shape
 * `executeProjectSetup` reads.
 *
 * - `orthographies` are names; Baseline is added here and is always first.
 * - `fields` are `{name, scope, lang}`. `lang` is the language the field's
 *   VALUES are in, recorded on the span layer. A format that calls it a
 *   writing system (FLEx) translates at its own call: `lang` is the word
 *   everything outside that importer uses.
 * - `ignoredTokens` is the wizard-shaped rule (see igtConfig). Left out, a
 *   project gets the default rule; passed `null`, setup writes none, which is
 *   what an archive that names no rule wants — the project keeps whatever it
 *   has rather than being told the default.
 * - `vocabularies` are wizard rows; a row setup should CREATE carries an id
 *   starting `new-`. `enabled` and `isCustom` default to true.
 * - `documentMetadata` are names.
 */
export function setupDataFor({
  projectName,
  orthographies = [],
  fields = [],
  ignoredTokens = defaultIgnoredTokensSetup(),
  vocabularies = [],
  documentMetadata = [],
}) {
  return {
    basicInfo: { projectName },
    orthographies: {
      orthographies: [
        { name: 'Baseline', isBaseline: true },
        ...orthographies.map((name) => ({ name })),
      ],
    },
    fields: {
      fields: fields.map((f) => ({
        name: f.name,
        scope: f.scope,
        lang: f.lang ?? null,
        isCustom: true,
      })),
      ignoredTokens: ignoredTokens ?? undefined,
    },
    vocabulary: {
      vocabularies: vocabularies.map((v) => ({
        enabled: true,
        isCustom: true,
        ...v,
      })),
    },
    documentMetadata: {
      enabledFields: documentMetadata.map((name) => ({ name, enabled: true, isCustom: true })),
    },
  };
}

// What a project is missing when setup did not finish, said the same way by
// every importer. The sentence names the state rather than the next step,
// because the next step differs: the wizard's own Retry, a resume from the
// project page, or setting the project up by hand.
const INCOMPLETE = 'Project setup incomplete';

/**
 * The ids an import engine writes to, off a project setup has run against.
 * `fields` is the flat list of `{name, scope}` the import needs; every one of
 * them must have a span layer or the project is not set up for this file.
 *
 * Throws when the substrate or a field is missing. The alignment layer is not
 * substrate: a project without one simply carries no time alignment, which the
 * engines report as a warning per document.
 */
export function resolveIgtTargets(project, fields = []) {
  const textLayer = findBaselineTextLayer(project.textLayers || []);
  if (!textLayer) throw new Error(`No baseline text layer. ${INCOMPLETE}`);
  const tokenLayers = textLayer.tokenLayers || [];
  const sentenceLayer = findSentenceTokenLayer(tokenLayers);
  const wordLayer = findWordTokenLayer(tokenLayers);
  const morphemeLayer = findMorphemeTokenLayer(tokenLayers);
  if (!sentenceLayer || !wordLayer || !morphemeLayer) {
    throw new Error(`Substrate token layers missing. ${INCOMPLETE}`);
  }
  const spanLayerByScopeName = new Map();
  for (const tl of tokenLayers) {
    for (const sl of tl.spanLayers || []) {
      spanLayerByScopeName.set(`${readScope(sl.config)}:${sl.name}`, sl.id);
    }
  }
  for (const f of fields) {
    if (!spanLayerByScopeName.has(`${f.scope}:${f.name}`)) {
      throw new Error(`Annotation field "${f.name}" (${f.scope}) missing. ${INCOMPLETE}`);
    }
  }
  return {
    textLayerId: textLayer.id,
    sentenceLayerId: sentenceLayer.id,
    wordLayerId: wordLayer.id,
    morphemeLayerId: morphemeLayer.id,
    alignmentLayerId: findAlignmentTokenLayer(tokenLayers)?.id ?? null,
    spanLayerByScopeName,
  };
}

/**
 * One document's shell: the document row, its baseline text, and the sentence
 * partition over it. Everything else a document holds hangs off what this
 * returns (`{documentId, textId, sentenceIds}`); a document with an empty
 * body gets no text and no sentences, unless `keepEmptyText` asks for the text
 * row anyway (the archive does, for a document whose text was cleared: the
 * row is still there and may hold metadata and comments).
 *
 * `metadata` is the caller's. As a function it is given the id the document
 * is created under, which an import's stamp names (resume.js). `textMetadata` is the baseline
 * text's, if the source carries one; as a function it is called once the
 * document exists, which is what an engine that resolves references against
 * the new document needs. `onDocument` is told the new id as soon as there is
 * one, before anything is written under it, and is awaited.
 * `createTokens(specs)` answers the new ids and lets an engine route the call
 * through its own writer (the archive import rewrites references in metadata
 * as it goes); without it the partition is written straight. `onText` is told the new text's id before
 * anything is written on it. `tokenEdges`, where the tokens to come begin and
 * end, go with the text (plaid-client `texts.create`), for a body a token edge
 * keeps decomposed.
 */
export async function createDocumentShell({
  client,
  projectId,
  targets,
  name,
  metadata,
  body,
  tokenEdges = null,
  sentences,
  textMetadata = undefined,
  keepEmptyText = false,
  onDocument = null,
  onText = null,
  createTokens = null,
  progress = () => {},
  check = () => {},
}) {
  progress('Creating document');
  const id = uuidv7();
  const created = await client.documents.create(
    projectId,
    name,
    typeof metadata === 'function' ? metadata(id) : metadata,
    undefined,
    { id },
  );
  const documentId = created.id ?? created;
  await onDocument?.(documentId);
  if (!body?.length && !keepEmptyText) return { documentId, textId: null, sentenceIds: [] };

  check();
  progress('Creating text');
  const text = await client.texts.create(
    targets.textLayerId,
    documentId,
    body ?? '',
    typeof textMetadata === 'function' ? textMetadata() : textMetadata,
    ...(tokenEdges?.length ? [undefined, { tokenEdges }] : []),
  );
  const textId = text.id ?? text;
  onText?.(textId);

  check();
  progress('Creating sentences');
  // The sentence layer PARTITIONS the text, and the server checks that the
  // tokens tile the whole extent on every bulk call. So this one cannot be
  // chunked: a first chunk ending mid-text is rejected with "Partition must
  // end at the extent's end". A long text therefore holds the write lock for
  // one big transaction, which is the cost of the invariant.
  const specs = sentences.map((s) => ({
    tokenLayerId: targets.sentenceLayerId,
    text: textId,
    begin: s.begin,
    end: s.end,
    ...(s.precedence != null ? { precedence: s.precedence } : {}),
    ...(s.metadata && Object.keys(s.metadata).length ? { metadata: s.metadata } : {}),
  }));
  const sentenceIds = !specs.length
    ? []
    : createTokens
      ? await createTokens(specs)
      : createdIds(await client.tokens.bulkCreate(specs));
  return { documentId, textId, sentenceIds };
}
