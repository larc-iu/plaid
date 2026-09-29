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
import { chunk } from '@/domain/bulk';
import { dropPrecedent } from '@/domain/precedentCache';
import { readVocabulary } from '@/domain/vocabCache';
import { extractAnalysis, analysisSignature } from '@/domain/analysisMemory';
import { isChangedElsewhere } from '@ui/lib/errors.js';
import { buildMatchSpec, hitsByDocQueries } from '../search/searchQueries.js';
import {
  collectRespellRows,
  collectLexiconRows,
  collectFieldRows,
  collectOccurrenceRows,
  respellOps,
} from './bulkPlan.js';

// Every apply, under one operation. The writes reach documents no editor has
// open, so the project precedent reads an editor took before them (the
// guesses, the lexicon popover's ranking) are dropped, whether the writes
// all landed or not. The operation is a bulk edit, and `action` (respell,
// replace, reanalyze, merge) says which, for a reader of the audit log.
async function writeAcrossDocuments(client, label, action, fn) {
  try {
    return await client.withOperation(label, fn, { kind: 'bulk-edit', ref: `action:${action}` });
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

// The version each document had when the preview read it: { [docId]: version }.
const versionsOf = (docs) => Object.fromEntries(docs.map((d) => [d.id, d.raw?.version]));

// Run `send` with every write it makes carrying `version` of document `docId`
// (the client's strict mode), so the server refuses the whole write when the
// document changed since that version was read. A document with no version
// known is never written unchecked.
async function atVersion(client, docId, version, send) {
  if (version == null) throw new Error('The document was read with no version.');
  client.documentVersions = { ...client.documentVersions, [docId]: version };
  client.enterStrictMode(docId);
  try {
    return await send();
  } finally {
    client.exitStrictMode();
  }
}

// One document's preview rows, sent at the version the preview read. A
// document changed since then is refused whole: it is read again
// (`replan(docId)`, resolving to { version, rows }), and the rows that still
// read as the preview showed them (`same(previewRow, freshRow)`) are sent
// once more, as re-planned, at the version just read. The rest are skipped,
// and every row when the document is refused a second time. `send(rows)`
// makes the writes. Resolves to { sent, skipped }, both lists of the
// preview's rows.
async function sendDocument(client, { docId, version, rows, replan, same, send }) {
  try {
    await atVersion(client, docId, version, () => send(rows));
    return { sent: rows, skipped: [] };
  } catch (e) {
    if (!isChangedElsewhere(e)) throw e;
  }
  const fresh = await replan(docId);
  const freshById = new Map(fresh.rows.map((r) => [r.id, r]));
  const kept = rows.filter((r) => freshById.has(r.id) && same(r, freshById.get(r.id)));
  const keptSet = new Set(kept);
  const skipped = rows.filter((r) => !keptSet.has(r));
  if (!kept.length) return { sent: [], skipped };
  try {
    await atVersion(client, docId, fresh.version, () => send(kept.map((r) => freshById.get(r.id))));
    return { sent: kept, skipped };
  } catch (e) {
    if (!isChangedElsewhere(e)) throw e;
    return { sent: [], skipped: rows };
  }
}

// Rows grouped by document, in first-seen order: Map docId -> rows.
const rowsByDoc = (rows) => {
  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.docId)) byDoc.set(r.docId, []);
    byDoc.get(r.docId).push(r);
  }
  return byDoc;
};

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
  // One document read again and planned with the same substitution, for a
  // document that changed between Preview and Apply.
  const replan = async (docId) => {
    const [doc] = await loadDocs(client, project, [[docId]], {}, undefined, layers);
    return { version: doc.raw?.version, rows: collectRespellRows(doc, apply) };
  };
  return { rows, lexiconRows, docs, versions: versionsOf(docs), replan };
}

// A respell row still reads as the preview showed it: the same word and the
// same new spelling, and, when they are respelled too, the same morpheme
// forms following it.
const sameRespell = (includeMorphemes) => (a, b) =>
  a.old === b.old &&
  a.new === b.new &&
  (!includeMorphemes || JSON.stringify(a.morphemes || []) === JSON.stringify(b.morphemes || []));

// The selected lexicon rows whose entry still has the form the preview read,
// read again from each vocabulary. A renamed or deleted entry is left out.
async function unchangedEntries(client, lexiconRows) {
  const byVocab = new Map();
  for (const r of lexiconRows) {
    if (!byVocab.has(r.vocabId)) byVocab.set(r.vocabId, []);
    byVocab.get(r.vocabId).push(r);
  }
  const kept = [];
  for (const [vocabId, vocabRows] of byVocab) {
    const vocab = await readVocabulary(client, vocabId);
    const formOf = new Map((vocab?.items || []).map((it) => [it.id, it.form]));
    kept.push(...vocabRows.filter((r) => formOf.get(r.id) === r.old));
  }
  return kept;
}

// Apply selected respell rows. Per document: one text update carrying every
// selected whole-token replace, and the morpheme forms it renames, in one
// atomic batch however many morphemes there are. The text edit and the forms
// that spell the same words must land together or the document reads as half
// respelled. Lexicon entries follow in their own requests.
//
// A text replace names offsets in the text as the preview read it, so each
// document's batch carries the version the preview read (`versions`), and a
// document changed since then is refused whole, read again, and respelled
// where its words still read as they did (`replan`, see sendDocument). A
// lexicon entry is renamed only while it still has the form the preview
// read. Returns { docsChanged, wordsChanged, morphemesChanged,
// entriesChanged, wordsSkipped, entriesSkipped }.
//
// A row that landed or was skipped is marked `applied` and left out of a
// later apply of the same plan, which would otherwise respell a document a
// second time.
export async function applyRespell(
  client,
  { rows, lexiconRows, versions, replan },
  { includeMorphemes, includeLexicon, label },
) {
  const byDoc = rowsByDoc(rows.filter((r) => !r.applied));
  const out = {
    docsChanged: 0,
    wordsChanged: 0,
    morphemesChanged: 0,
    entriesChanged: 0,
    wordsSkipped: 0,
    entriesSkipped: 0,
  };
  const formPatches = (part) =>
    part.map((m) => ({ id: m.id, metadata: [{ op: 'set', path: ['form'], value: m.new }] }));
  const morphemesOf = (docRows) => (includeMorphemes ? docRows.flatMap((r) => r.morphemes) : []);

  await writeAcrossDocuments(client, label, 'respell', async () => {
    for (const [docId, docRows] of byDoc) {
      const { sent, skipped } = await sendDocument(client, {
        docId,
        version: versions?.[docId],
        rows: docRows,
        replan,
        same: sameRespell(includeMorphemes),
        // Every chunk of morpheme forms rides in the same batch as the text
        // edit, so the document lands whole or not at all.
        send: (toSend) =>
          client.batched(async (b) => {
            b.texts.update(toSend[0].textId, respellOps(toSend));
            for (const part of chunk(morphemesOf(toSend))) b.tokens.bulkUpdate(formPatches(part));
          }),
      });
      docRows.forEach((r) => (r.applied = true));
      if (sent.length) out.docsChanged += 1;
      out.wordsChanged += sent.length;
      out.morphemesChanged += morphemesOf(sent).length;
      out.wordsSkipped += skipped.length;
    }
    if (includeLexicon) {
      const open = lexiconRows.filter((r) => !r.applied && !r.locked);
      const kept = await unchangedEntries(client, open);
      const keptSet = new Set(kept);
      for (const r of open) {
        if (keptSet.has(r)) continue;
        r.applied = true;
        out.entriesSkipped += 1;
      }
      for (const part of chunk(kept)) {
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
  const replan = async (docId) => {
    const [doc] = await loadDocs(client, project, [[docId]], {}, undefined, layers);
    return { version: doc.raw?.version, rows: collectFieldRows(doc, target, apply) };
  };
  return { rows, docs, versions: versionsOf(docs), replan };
}

// A value still reads as the preview showed it.
const sameValue = (a, b) => a.old === b.old && a.new === b.new;

// Span values, or morpheme forms, one document at a time, each document's in
// one batch carrying the version the preview read. A document changed since
// then is read again, and only the values that still read as the preview
// showed them are replaced (see sendDocument). Returns { changed, skipped }.
export async function applyField(client, { rows, versions, replan }, { label }) {
  let changed = 0;
  let skipped = 0;
  const send = (docRows) =>
    client.batched(async (b) => {
      const spanRows = docRows.filter((r) => r.kind !== 'morphForm');
      const morphRows = docRows.filter((r) => r.kind === 'morphForm');
      for (const part of chunk(spanRows)) {
        b.spans.bulkUpdate(part.map((r) => ({ id: r.id, value: r.new })));
      }
      for (const part of chunk(morphRows)) {
        b.tokens.bulkUpdate(
          part.map((r) => ({ id: r.id, metadata: [{ op: 'set', path: ['form'], value: r.new }] })),
        );
      }
    });
  await writeAcrossDocuments(client, label, 'replace', async () => {
    for (const [docId, docRows] of rowsByDoc(rows)) {
      const out = await sendDocument(client, {
        docId,
        version: versions?.[docId],
        rows: docRows,
        replan,
        same: sameValue,
        send,
      });
      changed += out.sent.length;
      skipped += out.skipped.length;
    }
  });
  return { changed, skipped };
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

// The signature of the analysis a word carries in `doc` now, null when it
// carries none (or is gone), as collectOccurrenceRows computes it.
const signatureNow = (doc, wordId) => {
  const token = doc.tokenLookup?.get(wordId);
  const analysis = token ? extractAnalysis(token) : null;
  return analysis ? analysisSignature(analysis) : null;
};

// Apply one analysis to the selected occurrences, document by document, all
// under one operation, each document's writes carrying the version the
// preview read (the document's own, `doc.raw.version`, as it stood when the
// plan was made). A document changed since then is read again (the refusal
// reads it, and so does a check of its version before the first write, since
// a run over unanalyzed words has nothing to strip and so no versioned write
// before it reads the document itself). Its occurrences whose analysis is no
// longer the one the preview showed are skipped, and the rest re-analyzed at
// the version just read. A document refused again is skipped whole. A
// document whose mutation fails otherwise stops the run (its error has
// already been surfaced through doc.onError). Earlier documents keep their
// changes, and the count reports how far it got. Returns { changed, skipped,
// failedDoc }.
export async function applyReanalyze(client, { rows, docs }, { analysis, label, onError }) {
  const docById = new Map(docs.map((d) => [d.id, d]));
  let changed = 0;
  let skipped = 0;
  let failedDoc = null;
  await writeAcrossDocuments(client, label, 'reanalyze', async () => {
    for (const [docId, docRows] of rowsByDoc(rows)) {
      const doc = docById.get(docId);
      if (!doc) continue;
      // A refusal because the document changed is this run's to handle, and
      // not an error to show.
      let refused = false;
      doc.onError = (msg, err, ...rest) => {
        if (err && isChangedElsewhere(err)) {
          refused = true;
          return;
        }
        onError?.(msg, err, ...rest);
      };
      const replace = (targets) =>
        atVersion(client, docId, doc.raw?.version, () =>
          doc.bulkReplaceAnalyses(targets.map((r) => ({ wordTokenId: r.id, analysis }))),
        );
      let targets = docRows;
      let n;
      const head = await client.documents.get(docId);
      if (head?.version !== doc.raw?.version) {
        await doc.reload();
        refused = true;
        n = false;
      } else {
        n = await replace(targets);
      }
      if (n === false && refused) {
        targets = docRows.filter((r) => signatureNow(doc, r.id) === r.signature);
        skipped += docRows.length - targets.length;
        refused = false;
        n = targets.length ? await replace(targets) : 0;
        if (n === false && refused) {
          skipped += targets.length;
          continue;
        }
      }
      if (n === false) {
        failedDoc = doc.document?.name || docId;
        break;
      }
      changed += n;
    }
  });
  return { changed, skipped, failedDoc };
}

// ---- merge ------------------------------------------------------------------

// How many words and morphemes are linked to the losing entries, and in how
// many documents, for the preview's summary: { tokens, docs }. The merge
// itself reads the links when it runs, so this is a count, not a plan.
export async function planMerge(client, vocabId, loserIds) {
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
  let tokens = 0;
  for (const n of docCounts.values()) tokens += n;
  return { tokens, docs: docCounts.size };
}

// Repoint every entry that referred to a loser (a dictionary's senses and
// reference fields, see planMergeRefs), then merge: the server moves every
// link of the losers to the survivor, the ones made after the preview
// included, drops a link on words the survivor already has, and deletes the
// losers. One batch, so a refusal leaves everything as it was, and a repeated
// merge changes nothing. `refUpdates` is `[{id, metadata}]` where the
// metadata is a list of metadata ops, as `metadataUpdates` builds it from
// planMergeRefs' whole maps. Returns what the server did.
export async function applyMerge(client, { refUpdates = [] }, { survivorId, loserIds, label }) {
  let merged = null;
  await writeAcrossDocuments(client, label, 'merge', async () => {
    const results = await client.batched((b) => {
      for (const part of chunk(refUpdates)) b.vocabItems.bulkUpdate(part);
      b.vocabItems.merge(survivorId, loserIds);
    });
    merged = results.at(-1)?.body ?? null;
  });
  return {
    linksMoved: merged?.moved ?? 0,
    duplicatesRemoved: merged?.duplicates ?? 0,
    entriesRemoved: merged?.removed?.length ?? 0,
    // The survivor can be in here too, when its own parent was one of the
    // losers. It does not point at itself, so it is not counted.
    entriesRepointed: refUpdates.filter((p) => p.id !== survivorId).length,
  };
}
