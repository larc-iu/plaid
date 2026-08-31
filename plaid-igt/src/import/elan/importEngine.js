// ELAN import engine — turns buildElanDocuments() output into plaid API writes.
//
// Same division of labour as the FLEx, CLDF and native engines: layer CREATION
// is the setup executor's job (the flow pre-fills the wizard from
// deriveSetupData and runs the normal setup), and this engine runs AFTER setup
// against the resolved project.
//
// Resumability follows the same scheme: a document is marked done
// (metadata.elanImported) only once every write for it succeeded, so on resume
// finished documents are skipped and half-imported ones are deleted and redone.
//
// The one thing this engine writes that the others do not is the time-alignment
// layer: a token per aligned segment carrying {timeBegin, timeEnd, speaker} in
// seconds, which is the whole reason an ELAN corpus is worth importing as such
// rather than as plain text.

import {
  findBaselineTextLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
  findMorphemeTokenLayer,
  findAlignmentTokenLayer,
  readScope,
} from '../../domain/igtConfig.js';

// Rows per bulk request. Each chunk is ONE server transaction holding the
// single SQLite write lock for its whole duration, so this bounds how long
// another writer can be made to wait, not just how many round trips we make.
const CHUNK = 500;
const DONE_KEY = 'elanImported';

export class ImportCancelled extends Error {
  constructor() {
    super('Import cancelled');
    this.name = 'ImportCancelled';
  }
}

async function bulkInChunks(items, check, send) {
  const ids = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    check?.();
    const res = await send(items.slice(i, i + CHUNK));
    if (res?.ids) ids.push(...res.ids);
  }
  return ids;
}

/** The setup-wizard input derived from a build. */
export function deriveSetupData(build, projectName) {
  return {
    basicInfo: { projectName },
    orthographies: {
      orthographies: [
        { name: 'Baseline', isBaseline: true },
        ...build.schema.orthographies.map((name) => ({ name })),
      ],
    },
    fields: {
      fields: build.schema.fields.map((f) => ({ name: f.name, scope: f.scope, isCustom: true })),
    },
    vocabulary: { vocabularies: [] },
    documentMetadata: {
      enabledFields: build.schema.documentMetadata.map((m) => ({
        name: m.name,
        enabled: true,
        isCustom: true,
      })),
    },
  };
}

/** Resolve engine write targets. Throws when setup did not produce them. */
export function resolveTargets(project, build) {
  const textLayer = findBaselineTextLayer(project.textLayers || []);
  if (!textLayer) throw new Error('No baseline text layer. Project setup incomplete');
  const tokenLayers = textLayer.tokenLayers || [];
  const sentenceLayer = findSentenceTokenLayer(tokenLayers);
  const wordLayer = findWordTokenLayer(tokenLayers);
  const morphemeLayer = findMorphemeTokenLayer(tokenLayers);
  if (!sentenceLayer || !wordLayer || !morphemeLayer) {
    throw new Error('Substrate token layers missing. Project setup incomplete');
  }
  const spanLayerByScopeName = new Map();
  for (const tl of tokenLayers) {
    for (const sl of tl.spanLayers || []) {
      spanLayerByScopeName.set(`${readScope(sl.config)}:${sl.name}`, sl.id);
    }
  }
  for (const f of build.schema.fields) {
    if (!spanLayerByScopeName.has(`${f.scope}:${f.name}`)) {
      throw new Error(
        `Annotation field "${f.name}" (${f.scope}) missing. Project setup incomplete`,
      );
    }
  }
  return {
    textLayerId: textLayer.id,
    sentenceLayerId: sentenceLayer.id,
    wordLayerId: wordLayer.id,
    morphemeLayerId: morphemeLayer.id,
    // Optional: a project without one simply carries no time alignment, which
    // is reported rather than treated as a failed setup.
    alignmentLayerId: findAlignmentTokenLayer(tokenLayers)?.id ?? null,
    spanLayerByScopeName,
  };
}

/** Import one document: text, sentences, alignment, words, morphemes, spans. */
export async function importDocument({
  client,
  projectId,
  targets,
  doc,
  onProgress,
  shouldStop,
  warnings,
}) {
  const progress = (step) => onProgress?.({ phase: 'document', doc: doc.name, step });
  const check = () => {
    if (shouldStop?.()) throw new ImportCancelled();
  };
  const spanLayerFor = (scope, name) => targets.spanLayerByScopeName.get(`${scope}:${name}`);

  progress('Creating document');
  const created = await client.documents.create(projectId, doc.name, doc.metadata);
  const docId = created.id ?? created;

  if (doc.body.length > 0) {
    progress('Creating text');
    const text = await client.texts.create(targets.textLayerId, docId, doc.body);
    const textId = text.id ?? text;

    check();
    progress('Creating sentences');
    const sentenceIds = await bulkInChunks(
      doc.sentences.map((s) => ({
        tokenLayerId: targets.sentenceLayerId,
        text: textId,
        begin: s.begin,
        end: s.end,
      })),
      check,
      (specs) => client.tokens.bulkCreate(specs),
    );

    // Time alignment. Seconds in metadata, matching the editor's own writes.
    if (doc.alignments.length && targets.alignmentLayerId) {
      check();
      progress('Creating time alignment');
      await bulkInChunks(
        doc.alignments.map((a) => {
          const metadata = { timeBegin: a.timeBegin, timeEnd: a.timeEnd };
          if (a.speaker) metadata.speaker = a.speaker;
          return {
            tokenLayerId: targets.alignmentLayerId,
            text: textId,
            begin: a.begin,
            end: a.end,
            metadata,
          };
        }),
        check,
        (specs) => client.tokens.bulkCreate(specs),
      );
    } else if (doc.alignments.length) {
      warnings?.push(
        `"${doc.name}": the project has no time-alignment layer, so ${doc.alignments.length} aligned segments were skipped.`,
      );
    }

    check();
    progress('Creating words');
    const wordIds = await bulkInChunks(
      doc.words.map((w) => {
        // Orthography values ride in token metadata under the orthog: prefix,
        // the same convention the editor and the other importers use.
        const metadata = {};
        for (const [key, value] of Object.entries(w.fields)) {
          if (key.startsWith('orthog:')) metadata[key] = value;
        }
        return {
          tokenLayerId: targets.wordLayerId,
          text: textId,
          begin: w.begin,
          end: w.end,
          metadata,
        };
      }),
      check,
      (specs) => client.tokens.bulkCreate(specs),
    );

    // Morphemes span the whole word with a 1-based precedence. Every word gets
    // at least one, which is the invariant reconcileOnOpen would otherwise heal
    // one at a time on first open.
    check();
    progress('Creating morphemes');
    const morphSpecs = [];
    for (const w of doc.words) {
      const morphemes = w.morphemes.length ? w.morphemes : [{ form: '', fields: {} }];
      morphemes.forEach((m, mi) => {
        const metadata = { form: m.form ?? '' };
        if (m.morphType) metadata.morphType = m.morphType;
        morphSpecs.push({
          morpheme: m,
          req: {
            tokenLayerId: targets.morphemeLayerId,
            text: textId,
            begin: w.begin,
            end: w.end,
            precedence: mi + 1,
            metadata,
          },
        });
      });
    }
    const morphIds = await bulkInChunks(
      morphSpecs.map((s) => s.req),
      check,
      (specs) => client.tokens.bulkCreate(specs),
    );

    check();
    progress('Creating annotations');
    const spanSpecs = [];
    const addSpan = (scope, name, tokenId, value) => {
      if (!value || !tokenId) return;
      const spanLayerId = spanLayerFor(scope, name);
      if (!spanLayerId) return;
      spanSpecs.push({ spanLayerId, tokens: [tokenId], value });
    };
    doc.sentences.forEach((s, si) => {
      for (const [name, value] of Object.entries(s.fields)) {
        addSpan('Sentence', name, sentenceIds[si], value);
      }
    });
    doc.words.forEach((w, wi) => {
      for (const [name, value] of Object.entries(w.fields)) {
        if (name.startsWith('orthog:')) continue; // already token metadata
        addSpan('Word', name, wordIds[wi], value);
      }
    });
    morphSpecs.forEach((s, i) => {
      for (const [name, value] of Object.entries(s.morpheme.fields || {})) {
        addSpan('Morpheme', name, morphIds[i], value);
      }
    });
    // The bulk endpoint requires every span in one call to share a layer.
    const byLayer = new Map();
    for (const s of spanSpecs) {
      if (!byLayer.has(s.spanLayerId)) byLayer.set(s.spanLayerId, []);
      byLayer.get(s.spanLayerId).push(s);
    }
    for (const specs of byLayer.values()) {
      await bulkInChunks(specs, check, (part) => client.spans.bulkCreate(part));
    }
  }

  // Marked LAST: resume treats an unmarked document as partial and redoes it.
  await client.documents.setMetadata(docId, { ...doc.metadata, [DONE_KEY]: true });
  return docId;
}

/**
 * Run a full import against a set-up project. The whole import is ONE logical
 * operation in the audit log; each write keeps its own description underneath.
 */
export async function runElanImport(args) {
  return args.client.withOperation('Import ELAN corpus', () => runElanImportImpl(args));
}

async function runElanImportImpl({ client, projectId, build, onProgress, shouldStop }) {
  const project = await client.projects.get(projectId);
  const targets = resolveTargets(project, build);
  const warnings = [...build.warnings];

  // Resume bookkeeping: list existing documents once (auto-paginated).
  const existing = await client.projects.listDocuments(projectId);
  const byName = new Map(existing.map((d) => [d.name, d]));

  const results = { imported: 0, skipped: 0, redone: 0 };
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
    const prior = byName.get(doc.name);
    if (prior) {
      const full = await client.documents.get(prior.id);
      if (full.metadata?.[DONE_KEY]) {
        results.skipped += 1;
        continue;
      }
      await client.documents.delete(prior.id); // half-imported: redo cleanly
      results.redone += 1;
    }
    await importDocument({
      client,
      projectId,
      targets,
      doc,
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
