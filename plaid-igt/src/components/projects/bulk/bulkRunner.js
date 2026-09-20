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

// Entities per bulk request. Every write here goes to a bulk endpoint, which
// dispatches the REST stack ONCE and does the work set-wise, rather than a
// batch of one op per entity — a batch re-dispatches routing, auth, the ACL
// lookup and an operation per sub-op, all while holding the single SQLite
// write lock. What this bounds is that hold: a request is one transaction, and
// a writer arriving mid-request waits, then is refused with a 503 once the
// server's busy_timeout runs out. Same number and same reason as the
// importers' `CHUNK` (src/import/bulk.js).
const BULK_CHUNK = 500;

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
        vocabularies: rebaseVocabLinks(vocabularies),
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
// selected whole-token replace, and the morpheme forms it renames, in one
// atomic batch of two ops however many morphemes there are — the text edit
// and the forms that spell the same words must land together or the document
// reads as half respelled. Lexicon entries follow in their own requests.
// Returns { docsChanged, wordsChanged, morphemesChanged, entriesChanged }.
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
  const formPatches = (part) => part.map((m) => ({ id: m.id, metadata: { form: m.new } }));

  await client.withOperation(label, async () => {
    for (const docRows of byDoc.values()) {
      const textId = docRows[0].textId;
      const morphPatches = includeMorphemes ? docRows.flatMap((r) => r.morphemes) : [];
      // A document with more morpheme forms than one request should carry
      // sends the rest after: the first chunk is the one that has to be
      // atomic with the text edit.
      const [first, ...rest] = chunk(morphPatches, BULK_CHUNK);
      await client.batched(async (b) => {
        b.texts.update(textId, respellOps(docRows));
        if (first?.length) b.tokens.bulkUpdate(formPatches(first));
      });
      for (const part of rest) await client.tokens.bulkUpdate(formPatches(part));
      out.docsChanged += 1;
      out.wordsChanged += docRows.length;
      out.morphemesChanged += morphPatches.length;
    }
    if (includeLexicon) {
      for (const part of chunk(lexiconRows, BULK_CHUNK)) {
        await client.vocabItems.bulkUpdate(part.map((r) => ({ id: r.id, form: r.new })));
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

// Span values, or morpheme forms, in bulk. Both bulk updates reach across
// documents within the project, so a replace touching a thousand values in
// fifty documents is a couple of requests rather than a couple of hundred.
export async function applyField(client, { rows }, { label }) {
  let changed = 0;
  const morphRows = rows.filter((r) => r.kind === 'morphForm');
  const spanRows = rows.filter((r) => r.kind !== 'morphForm');
  await client.withOperation(label, async () => {
    for (const part of chunk(spanRows, BULK_CHUNK)) {
      await client.spans.bulkUpdate(part.map((r) => ({ id: r.id, value: r.new })));
      changed += part.length;
    }
    for (const part of chunk(morphRows, BULK_CHUNK)) {
      await client.tokens.bulkUpdate(part.map((r) => ({ id: r.id, metadata: { form: r.new } })));
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

// Recreate each link on the survivor, repoint every entry that referred to a
// loser (a dictionary's senses and reference fields, see planMergeRefs),
// then delete the losing entries (their old links cascade away server-side).
// Under one operation. `refUpdates` is `[{id, metadata}]` where the metadata
// is a PATCH, as `metadataUpdates` builds it from planMergeRefs' whole maps.
//
// Link creates go per document: a bulk vocab-link create takes tokens from
// one document, and a merge harvests links from every document that used the
// losing entries.
export async function applyMerge(
  client,
  { links, refUpdates = [] },
  { survivorId, loserIds, label },
) {
  const byDoc = new Map();
  for (const l of links) {
    if (!byDoc.has(l.docId)) byDoc.set(l.docId, []);
    byDoc.get(l.docId).push(l);
  }
  await client.withOperation(label, async () => {
    for (const docLinks of byDoc.values()) {
      for (const part of chunk(docLinks, BULK_CHUNK)) {
        await client.vocabLinks.bulkCreate(
          part.map((l) => ({
            vocabItem: survivorId,
            tokens: l.tokens,
            ...(l.metadata ? { metadata: l.metadata } : {}),
          })),
        );
      }
    }
    for (const part of chunk(refUpdates, BULK_CHUNK)) {
      await client.vocabItems.bulkUpdate(part);
    }
    await client.vocabItems.bulkDelete(loserIds);
  });
  return {
    linksMoved: links.length,
    entriesRemoved: loserIds.length,
    // The survivor can be in here too, when its own parent was one of the
    // losers. It does not point at itself, so it is not counted.
    entriesRepointed: refUpdates.filter((p) => p.id !== survivorId).length,
  };
}
