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

import { IgtDocument, loadProjectVocabularies, rebaseVocabLinks } from '@/domain/IgtDocument';
import { readAll, readLayerIds } from '@/domain/documentReads';
import { shareVocabularies } from '@/domain/vocabLookup';
import { readIgnoredTokens } from '@/domain/igtConfig';
import { chunk, CHUNK } from '@/domain/bulk';
import { dropPrecedent } from '@/domain/precedentCache';
import { buildMatchSpec, hitsByDocQueries } from '../search/searchQueries.js';
import {
  collectRespellRows,
  collectLexiconRows,
  collectFieldRows,
  collectOccurrenceRows,
  collectLinksToMove,
  respellOps,
} from './bulkPlan.js';

// Every apply, under one operation. The writes reach documents no editor has
// open, so the project precedent reads an editor took before them (the
// guesses, the lexicon popover's ranking) are dropped, whether the writes
// all landed or not.
async function writeAcrossDocuments(client, label, fn) {
  try {
    return await client.withOperation(label, fn);
  } finally {
    dropPrecedent();
  }
}

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

// Read the documents a change touches, four at a time and in the order
// given (documentReads.js), each narrowed to `layers`. `onProgress(done,
// total)` drives the progress line. Each IgtDocument gets its own link-free
// copy of the vocabulary map, since the constructor folds that document's
// links into it. The entry lists inside are shared by every document.
async function loadDocs(client, project, docEntries, vocabularies, onProgress, layers) {
  const raws = await readAll(
    docEntries.map(([docId]) => docId),
    (docId) => client.documents.get(docId, true, undefined, layers),
    { onProgress },
  );
  return raws.map(
    (raw) =>
      new IgtDocument({
        raw,
        project,
        vocabularies: rebaseVocabLinks(vocabularies),
        client,
        projectId: project.id,
      }),
  );
}

// ---- respell --------------------------------------------------------------

export async function planRespell(
  client,
  project,
  layerInfo,
  { find, matchType, apply, canRespellIn },
  onProgress,
) {
  const domain = { kind: 'token', layerId: layerInfo.primaryTokenLayer.id };
  const [docEntries, { vocabularies }] = await Promise.all([
    findDocs(client, domain, buildMatchSpec(find, matchType)),
    loadProjectVocabularies(client, project),
  ]);
  // The text, the words and the morphemes: no annotation field.
  const layers = readLayerIds(project, { spans: [] });
  const docs = await loadDocs(client, project, docEntries, {}, onProgress, layers);
  const rows = docs.flatMap((doc) => collectRespellRows(doc, apply));
  const lexiconRows = collectLexiconRows(vocabularies, apply, canRespellIn);
  return { rows, lexiconRows, docs };
}

// Apply selected respell rows. Per document: one text update carrying every
// selected whole-token replace, and the morpheme forms it renames, in one
// atomic batch however many morphemes there are — the text edit
// and the forms that spell the same words must land together or the document
// reads as half respelled. Lexicon entries follow in their own requests.
// Returns { docsChanged, wordsChanged, morphemesChanged, entriesChanged }.
//
// A row that landed is marked `applied` and skipped by a later apply of the
// same plan. A text replace names offsets in the text as the preview read it,
// so Apply again after a refusal partway would otherwise respell the
// documents before it a second time, over text that already changed.
export async function applyRespell(
  client,
  { rows, lexiconRows },
  { includeMorphemes, includeLexicon, label },
) {
  const byDoc = new Map();
  for (const r of rows) {
    if (r.applied) continue;
    if (!byDoc.has(r.docId)) byDoc.set(r.docId, []);
    byDoc.get(r.docId).push(r);
  }
  const out = { docsChanged: 0, wordsChanged: 0, morphemesChanged: 0, entriesChanged: 0 };
  const formPatches = (part) =>
    part.map((m) => ({ id: m.id, metadata: [{ op: 'set', path: ['form'], value: m.new }] }));

  await writeAcrossDocuments(client, label, async () => {
    for (const docRows of byDoc.values()) {
      const textId = docRows[0].textId;
      const morphPatches = includeMorphemes ? docRows.flatMap((r) => r.morphemes) : [];
      // Every chunk of morpheme forms rides in the same batch as the text
      // edit, so the document lands whole or not at all.
      await client.batched(async (b) => {
        b.texts.update(textId, respellOps(docRows));
        for (const part of chunk(morphPatches)) b.tokens.bulkUpdate(formPatches(part));
      });
      docRows.forEach((r) => (r.applied = true));
      out.docsChanged += 1;
      out.wordsChanged += docRows.length;
      out.morphemesChanged += morphPatches.length;
    }
    if (includeLexicon) {
      for (const part of chunk(lexiconRows.filter((r) => !r.applied && !r.locked))) {
        await client.vocabItems.bulkUpdate(part.map((r) => ({ id: r.id, form: r.new })));
        part.forEach((r) => (r.applied = true));
        out.entriesChanged += part.length;
      }
    }
  });
  return out;
}

// ---- field ----------------------------------------------------------------

export async function planField(client, project, target, { find, matchType, apply }, onProgress) {
  const docEntries = await findDocs(client, target, buildMatchSpec(find, matchType));
  // The one field replaced, or none for morpheme forms.
  const layers = readLayerIds(project, { spans: target.kind === 'span' ? [target.layerId] : [] });
  const docs = await loadDocs(client, project, docEntries, {}, onProgress, layers);
  const rows = docs.flatMap((doc) => collectFieldRows(doc, target, apply));
  return { rows, docs };
}

// Span values, or morpheme forms, in bulk. Both bulk updates reach across
// documents within the project, so a replace touching a thousand values in
// fifty documents is a couple of requests rather than a couple of hundred.
export async function applyField(client, { rows }, { label }) {
  let changed = 0;
  const morphRows = rows.filter((r) => r.kind === 'morphForm');
  const spanRows = rows.filter((r) => r.kind !== 'morphForm');
  await writeAcrossDocuments(client, label, async () => {
    for (const part of chunk(spanRows)) {
      await client.spans.bulkUpdate(part.map((r) => ({ id: r.id, value: r.new })));
      changed += part.length;
    }
    for (const part of chunk(morphRows)) {
      await client.tokens.bulkUpdate(
        part.map((r) => ({ id: r.id, metadata: [{ op: 'set', path: ['form'], value: r.new }] })),
      );
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
  // real item tables to resolve the analysis's vocab links, and every field
  // an analysis can carry. The entry lists are shared, so each index over
  // them is built once for the run rather than once per document.
  shareVocabularies(vocabularies);
  const layers = readLayerIds(project);
  const docs = await loadDocs(client, project, docEntries, vocabularies, onProgress, layers);
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
  await writeAcrossDocuments(client, label, async () => {
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
export async function planMerge(
  client,
  project,
  vocabId,
  loserIds,
  onProgress,
  { survivorId = null } = {},
) {
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
  // Every token layer of the project, since a link comes back with the token
  // layer it is on, and no annotation field.
  const layers = readLayerIds(project, { tokenLayers: 'all', spans: [] });
  const docs = await loadDocs(client, project, docEntries, {}, onProgress, layers);
  const links = docs.flatMap((doc) => collectLinksToMove(doc, loserIds, survivorId));
  return { links, docs };
}

// Recreate each link on the survivor, repoint every entry that referred to a
// loser (a dictionary's senses and reference fields, see planMergeRefs),
// then delete the losing entries (their old links cascade away server-side).
// Under one operation. `refUpdates` is `[{id, metadata}]` where the metadata
// is a list of metadata ops, as `metadataUpdates` builds it from planMergeRefs'
// whole maps.
//
// A merge of up to one chunk of entities is ONE batch: a refusal anywhere
// leaves the words linked to the losers alone, so the plan on screen is still
// what a retry needs. A larger one cannot be: a batch is one transaction
// holding the server's only write lock, and past MAX_BATCH_OPS the client
// splits it anyway. So it goes a chunk at a time, document by document, then
// the references, then the delete. A link that landed is marked `applied` and
// Apply again skips it, so a retry after a refusal partway never links a word
// to the survivor twice (and planMerge leaves out a word the survivor has).
//
// Link creates go per document: a bulk vocab-link create takes tokens from
// one document, and a merge harvests links from every document that used the
// losing entries.
export async function applyMerge(
  client,
  { links, refUpdates = [] },
  { survivorId, loserIds, label },
) {
  const pending = links.filter((l) => !l.applied);
  const byDoc = new Map();
  for (const l of pending) {
    if (!byDoc.has(l.docId)) byDoc.set(l.docId, []);
    byDoc.get(l.docId).push(l);
  }
  const specs = (part) =>
    part.map((l) => ({
      vocabItem: survivorId,
      tokens: l.tokens,
      ...(l.metadata ? { metadata: l.metadata } : {}),
    }));
  if (pending.length + refUpdates.length <= CHUNK) {
    await writeAcrossDocuments(client, label, () =>
      client.batched((b) => {
        for (const docLinks of byDoc.values()) b.vocabLinks.bulkCreate(specs(docLinks));
        if (refUpdates.length) b.vocabItems.bulkUpdate(refUpdates);
        b.vocabItems.bulkDelete(loserIds);
      }),
    );
    pending.forEach((l) => (l.applied = true));
  } else {
    await writeAcrossDocuments(client, label, async () => {
      for (const docLinks of byDoc.values()) {
        for (const part of chunk(docLinks)) {
          await client.vocabLinks.bulkCreate(specs(part));
          part.forEach((l) => (l.applied = true));
        }
      }
      for (const part of chunk(refUpdates)) await client.vocabItems.bulkUpdate(part);
      await client.vocabItems.bulkDelete(loserIds);
    });
  }
  return {
    linksMoved: links.length,
    entriesRemoved: loserIds.length,
    // The survivor can be in here too, when its own parent was one of the
    // losers. It does not point at itself, so it is not counted.
    entriesRepointed: refUpdates.filter((p) => p.id !== survivorId).length,
  };
}
