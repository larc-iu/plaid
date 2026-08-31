// Orchestration for the project Bulk Edit tab: find the documents a change
// touches, load them, plan the rows (bulkPlan.js), and apply the selected
// rows as writes. Every apply runs under ONE client operation, so the
// History drawer shows a single revertable "Respell kat → cat (412 words)"
// entry per document rather than hundreds of writes.
//
// Discovery reuses the Search tab's per-document count queries: the server
// tells us WHICH documents contain matches (fast, uncapped), and the rows are
// then computed locally from each document's derived sentences with the same
// code the editor renders from. That keeps the preview exact (offsets, morpheme
// forms, current analyses) without asking the query language to project things
// it can't.

import { IgtDocument, loadProjectVocabularies } from '@/domain/IgtDocument';
import { readIgnoredTokens } from '@/domain/igtConfig';
import { buildMatchSpec, hitsByDocQueries } from '../search/searchQueries.js';
import {
  collectRespellRows,
  collectLexiconRows,
  collectFieldRows,
  collectOccurrenceRows,
  collectLinksToMove,
  respellOps,
  chunk,
} from './bulkPlan.js';

// Ops per atomic batch: comfortably under plaid-core's 1000-op cap.
// Ops per batch. A batch is ONE server transaction holding the single SQLite
// write lock until it commits, and every sub-op re-dispatches the whole REST
// stack inside that hold — so this bounds how long a concurrent writer waits
// before the server's busy_timeout refuses it with a 503, not just the number
// of round trips.
const BATCH_CHUNK = 200;

// Documents with at least one server-side match for `domain`/`spec`, busiest
// first: [[docId, count], ...].
async function findDocs(client, domain, spec) {
  const results = await Promise.all(hitsByDocQueries(domain, spec).map((q) => client.query(q)));
  const counts = new Map();
  for (const r of results) {
    for (const [docId, n] of r?.results || [])
      counts.set(String(docId), (counts.get(String(docId)) || 0) + n);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// Vocab tables are mutated by mergeRawVocabLinks (each document folds its own
// links in), so every IgtDocument gets its own link-free copy of the shared
// item tables.
const freshVocabs = (vocabularies) => {
  const out = {};
  for (const [id, v] of Object.entries(vocabularies || {})) out[id] = { ...v, vocabLinks: [] };
  return out;
};

// Load documents one at a time (a bulk edit can touch every document in the
// project, and a burst of parallel GETs for big documents is what makes the
// tab feel stuck). `onProgress(done, total)` drives the progress line.
async function loadDocs(client, project, docEntries, vocabularies, onProgress) {
  const docs = [];
  let done = 0;
  for (const [docId] of docEntries) {
    const raw = await client.documents.get(docId, true);
    docs.push(
      new IgtDocument({
        raw,
        project,
        vocabularies: freshVocabs(vocabularies),
        client,
        projectId: project.id,
      }),
    );
    done += 1;
    onProgress?.(done, docEntries.length);
  }
  return docs;
}

// ---- respell --------------------------------------------------------------

export async function planRespell(
  client,
  project,
  layerInfo,
  { find, matchType, apply },
  onProgress,
) {
  const domain = { kind: 'token', layerId: layerInfo.primaryTokenLayer.id };
  const [docEntries, { vocabularies }] = await Promise.all([
    findDocs(client, domain, buildMatchSpec(find, matchType)),
    loadProjectVocabularies(client, project),
  ]);
  const docs = await loadDocs(client, project, docEntries, {}, onProgress);
  const rows = docs.flatMap((doc) => collectRespellRows(doc, apply));
  const lexiconRows = collectLexiconRows(vocabularies, apply);
  return { rows, lexiconRows, docs };
}

// Apply selected respell rows. Per document: one text update carrying every
// selected whole-token replace (plus that document's morpheme-form patches)
// in one atomic batch. Lexicon entries follow in their own batches. Returns
// { docsChanged, wordsChanged, morphemesChanged, entriesChanged }.
export async function applyRespell(
  client,
  { rows, lexiconRows },
  { includeMorphemes, includeLexicon, label },
) {
  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.docId)) byDoc.set(r.docId, []);
    byDoc.get(r.docId).push(r);
  }
  const out = { docsChanged: 0, wordsChanged: 0, morphemesChanged: 0, entriesChanged: 0 };

  await client.withOperation(label, async () => {
    for (const docRows of byDoc.values()) {
      const textId = docRows[0].textId;
      const morphPatches = includeMorphemes ? docRows.flatMap((r) => r.morphemes) : [];
      // The text update is one op; morpheme patches fill the rest of the
      // first batch and spill into further batches for a huge document.
      const parts = chunk(morphPatches, BATCH_CHUNK - 1);
      if (!parts.length) parts.push([]);
      for (let i = 0; i < parts.length; i++) {
        await client.batched(async () => {
          if (i === 0) client.texts.update(textId, respellOps(docRows));
          parts[i].forEach((m) => client.tokens.patchMetadata(m.id, { form: m.new }));
        });
      }
      out.docsChanged += 1;
      out.wordsChanged += docRows.length;
      out.morphemesChanged += morphPatches.length;
    }
    if (includeLexicon) {
      for (const part of chunk(lexiconRows, BATCH_CHUNK)) {
        await client.batched(async () => {
          part.forEach((r) => client.vocabItems.update(r.id, r.new));
        });
        out.entriesChanged += part.length;
      }
    }
  });
  return out;
}

// ---- field ----------------------------------------------------------------

export async function planField(client, project, target, { find, matchType, apply }, onProgress) {
  const docEntries = await findDocs(client, target, buildMatchSpec(find, matchType));
  const docs = await loadDocs(client, project, docEntries, {}, onProgress);
  const rows = docs.flatMap((doc) => collectFieldRows(doc, target, apply));
  return { rows, docs };
}

// Span value updates (or morpheme-form patches) in atomic batches.
export async function applyField(client, { rows }, { label }) {
  let changed = 0;
  await client.withOperation(label, async () => {
    for (const part of chunk(rows, BATCH_CHUNK)) {
      await client.batched(async () => {
        for (const r of part) {
          if (r.kind === 'morphForm') client.tokens.patchMetadata(r.id, { form: r.new });
          else client.spans.update(r.id, r.new);
        }
      });
      changed += part.length;
    }
  });
  return { changed };
}

// ---- reanalyze --------------------------------------------------------------

export async function planReanalyze(client, project, layerInfo, form, onProgress) {
  const domain = { kind: 'token', layerId: layerInfo.primaryTokenLayer.id };
  const [docEntries, { vocabularies }] = await Promise.all([
    findDocs(client, domain, form),
    loadProjectVocabularies(client, project),
  ]);
  // These documents will be MUTATED (bulkReplaceAnalyses), so they need the
  // real item tables to resolve the analysis's vocab links.
  const docs = await loadDocs(client, project, docEntries, vocabularies, onProgress);
  const ignoredCfg = readIgnoredTokens(layerInfo.primaryTokenLayer?.config);
  const rows = docs.flatMap((doc) => collectOccurrenceRows(doc, form, ignoredCfg));
  const itemFormById = new Map();
  for (const v of Object.values(vocabularies)) {
    for (const it of v.items || []) itemFormById.set(it.id, it.form);
  }
  return { rows, docs, itemFormById };
}

// Apply one analysis to the selected occurrences, document by document, all
// under one operation. A document whose mutation fails stops the run (its
// error has already been surfaced through doc.onError); earlier documents
// keep their changes, and the count reports how far it got.
export async function applyReanalyze(client, { rows, docs }, { analysis, label, onError }) {
  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.docId)) byDoc.set(r.docId, []);
    byDoc.get(r.docId).push(r);
  }
  const docById = new Map(docs.map((d) => [d.id, d]));
  let changed = 0;
  let failedDoc = null;
  await client.withOperation(label, async () => {
    for (const [docId, docRows] of byDoc) {
      const doc = docById.get(docId);
      if (!doc) continue;
      doc.onError = onError || null;
      const n = await doc.bulkReplaceAnalyses(
        docRows.map((r) => ({ wordTokenId: r.id, analysis })),
      );
      if (n === false) {
        failedDoc = doc.document?.name || docId;
        break;
      }
      changed += n;
    }
  });
  return { changed, failedDoc };
}

// ---- merge ------------------------------------------------------------------

// Every vocab link pointing at a losing entry, harvested from the documents
// that carry them (links are embedded in document GETs, and the query
// language addresses linked tokens rather than link ids).
export async function planMerge(client, project, vocabId, loserIds, onProgress) {
  const docCounts = new Map();
  for (const itemId of loserIds) {
    const r = await client.query({
      where: [
        ['vocab', '?v', { layer: vocabId }],
        ['=', '?v.id', itemId],
        ['vocab-link', '?t', '?v'],
        ['token', '?t', { doc: { var: '?d' } }],
      ],
      return: { group: ['?d'], aggregates: [['count']] },
    });
    for (const [docId, n] of r?.results || [])
      docCounts.set(String(docId), (docCounts.get(String(docId)) || 0) + n);
  }
  const docEntries = [...docCounts.entries()].sort((a, b) => b[1] - a[1]);
  const docs = await loadDocs(client, project, docEntries, {}, onProgress);
  const links = docs.flatMap((doc) => collectLinksToMove(doc, loserIds));
  return { links, docs };
}

// Recreate each link on the survivor, then delete the losing entries (their
// old links cascade away server-side). Under one operation.
export async function applyMerge(client, { links }, { survivorId, loserIds, label }) {
  await client.withOperation(label, async () => {
    for (const part of chunk(links, BATCH_CHUNK)) {
      await client.batched(async () => {
        part.forEach((l) =>
          client.vocabLinks.create(survivorId, l.tokens, l.metadata || undefined),
        );
      });
    }
    await client.vocabItems.bulkDelete(loserIds);
  });
  return { linksMoved: links.length, entriesRemoved: loserIds.length };
}
