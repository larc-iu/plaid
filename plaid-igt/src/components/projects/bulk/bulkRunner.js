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
import { isChangedElsewhere, statusOf } from '@ui/lib/errors.js';
import { buildMatchSpec, hitsByDocQueries } from '../search/searchQueries.js';
import {
  collectRespellRows,
  collectLexiconRows,
  collectFieldRows,
  collectOccurrenceRows,
  respellOps,
  respellBarred,
  blank,
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
// once more, as re-planned, at the version just read. A row that already
// reads as the preview's new value (`landed(previewRow, nowRow)`, against the
// re-read's `now`, every entity as it reads, and undefined for one that is
// gone) is counted as sent: it is this run's own write from an attempt whose
// answer was lost. The rest are
// skipped, and every row but those when the document is refused a second
// time. `send(rows)` makes the writes. Resolves to { sent, skipped }, both
// lists of the preview's rows.
async function sendDocument(client, { docId, version, rows, replan, same, landed, send }) {
  try {
    await atVersion(client, docId, version, () => send(rows));
    return { sent: rows, skipped: [] };
  } catch (e) {
    if (!isChangedElsewhere(e)) throw e;
  }
  let fresh;
  try {
    fresh = await replan(docId);
  } catch (e) {
    if (unreadable(e)) return { sent: [], skipped: rows };
    throw e;
  }
  const freshById = new Map(fresh.rows.map((r) => [r.id, r]));
  const kept = rows.filter((r) => freshById.has(r.id) && same(r, freshById.get(r.id)));
  const keptSet = new Set(kept);
  const already = rows.filter(
    (r) => !keptSet.has(r) && landed && fresh.now && landed(r, fresh.now.get(r.id)),
  );
  const alreadySet = new Set(already);
  const skipped = rows.filter((r) => !keptSet.has(r) && !alreadySet.has(r));
  if (!kept.length) return { sent: already, skipped };
  try {
    await atVersion(client, docId, fresh.version, () => send(kept.map((r) => freshById.get(r.id))));
    return { sent: [...already, ...kept], skipped };
  } catch (e) {
    if (!isChangedElsewhere(e)) throw e;
    return { sent: already, skipped: [...skipped, ...kept] };
  }
}

// Every entity a collector plans over, as it reads now: the collector run
// with a substitution that changes nothing, so each row's `old` is the
// current value. Map id -> row.
const readingNow = (collect, doc, ...args) => new Map(collect(doc, ...args).map((r) => [r.id, r]));

// A document read again that cannot be read: deleted since the preview (404),
// or no longer this person's to read (403). Its rows are skipped.
const unreadable = (e) => statusOf(e) === 404 || statusOf(e) === 403;

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
    return {
      version: doc.raw?.version,
      rows: collectRespellRows(doc, apply),
      now: readingNow(collectRespellRows, doc, (v) => v),
    };
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

// A respell row already reads as respelled: the word, and when they are
// respelled too, its morpheme forms.
const landedRespell = (includeMorphemes) => (row, now) =>
  !!now &&
  now.old === row.new &&
  (!includeMorphemes ||
    (row.morphemes || []).every(
      (m) => (now.morphemes || []).find((x) => x.id === m.id)?.old === m.new,
    ));

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
    for (const r of vocabRows) if (formOf.get(r.id) === r.old) kept.push(r);
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
// entriesChanged, wordsSkipped, entriesSkipped, failed? }, `failed` when it
// stopped partway after something landed (see stoppedOrDone).
//
// A row that landed or was skipped is marked `applied` and left out of a
// later apply of the same plan, which would otherwise respell a document a
// second time.
export async function applyRespell(
  client,
  { rows, lexiconRows, versions, replan },
  { includeMorphemes, includeLexicon, label, onProgress },
) {
  // A row that would empty a word or a form is never written, whoever ticked it.
  const writable = (r) => !respellBarred(r, includeMorphemes);
  const byDoc = rowsByDoc(rows.filter((r) => !r.applied && writable(r)));
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
    let n = 0;
    for (const [docId, docRows] of byDoc) {
      onProgress?.((n += 1), byDoc.size);
      const res = await sendDocument(client, {
        docId,
        version: versions?.[docId],
        rows: docRows,
        replan,
        same: sameRespell(includeMorphemes),
        landed: landedRespell(includeMorphemes),
        // Every chunk of morpheme forms rides in the same batch as the text
        // edit, so the document lands whole or not at all.
        send: (planned) => {
          const toSend = planned.filter(writable);
          if (!toSend.length) return Promise.resolve([]);
          return client.batched(async (b) => {
            b.texts.update(toSend[0].textId, respellOps(toSend));
            for (const part of chunk(morphemesOf(toSend))) b.tokens.bulkUpdate(formPatches(part));
          });
        },
      }).catch((error) => {
        out.failed = { docName: docRows[0]?.docName ?? null, error };
        return null;
      });
      if (!res) return;
      const { sent, skipped } = res;
      docRows.forEach((r) => (r.applied = true));
      if (sent.length) out.docsChanged += 1;
      out.wordsChanged += sent.length;
      out.morphemesChanged += morphemesOf(sent).length;
      out.wordsSkipped += skipped.length;
    }
    if (includeLexicon) {
      try {
        const open = lexiconRows.filter((r) => !r.applied && !r.locked && !r.invalid);
        if (open.length) onProgress?.('Respelling lexicon entries…');
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
      } catch (error) {
        out.failed = { docName: null, error };
      }
    }
  });
  return stoppedOrDone(out, out.docsChanged + out.entriesChanged);
}

// A run that failed partway: with nothing written, its error is thrown as
// before. With something written, the run resolves with `failed`
// ({ docName, error }: the document it stopped at, null for the lexicon
// entries), so the toast can say what landed before the stop.
const stoppedOrDone = (out, written) => {
  if (out.failed && !written) throw out.failed.error;
  return out;
};

// ---- field ----------------------------------------------------------------

export async function planField(client, project, target, { find, matchType, apply }, onProgress) {
  const docEntries = await findDocs(client, target, buildMatchSpec(find, matchType));
  // The one field replaced, or none for morpheme forms.
  const layers = readLayerIds(project, { spans: target.kind === 'span' ? [target.layerId] : [] });
  const docs = await loadDocs(client, project, docEntries, {}, onProgress, layers);
  const rows = docs.flatMap((doc) => collectFieldRows(doc, target, apply));
  const replan = async (docId) => {
    const [doc] = await loadDocs(client, project, [[docId]], {}, undefined, layers);
    return {
      version: doc.raw?.version,
      rows: collectFieldRows(doc, target, apply),
      now: readingNow(collectFieldRows, doc, target, (v) => v),
    };
  };
  return { rows, docs, versions: versionsOf(docs), replan };
}

// A value still reads as the preview showed it.
const sameValue = (a, b) => a.old === b.old && a.new === b.new;

// A value already reads as the preview's new one. A cleared span is gone.
const landedValue = (row, now) => (now ? now.old === row.new : clears(row));

// A span row the replacement empties: the span is deleted, never stored as ''.
const clears = (row) => row.kind === 'span' && blank(row.new);

// Span values, or morpheme forms, one document at a time, each document's in
// one batch carrying the version the preview read. A document changed since
// then is read again, and only the values that still read as the preview
// showed them are replaced (see sendDocument). Returns { changed, skipped,
// failed }, and `cleared`, how many of `changed` were cleared, when any were.
//
// A row that landed or was skipped is marked `applied` and left out of a
// later apply of the same plan, as Respell's are, so Apply again after a
// stop partway sends only the documents that did not land. A stop after a
// document landed resolves with `failed` (see stoppedOrDone).
export async function applyField(client, { rows, versions, replan }, { label, onProgress }) {
  let changed = 0;
  let cleared = 0;
  let skipped = 0;
  let failed = null;
  // A span the replacement empties is deleted in the same batch, and a
  // morpheme form it empties is never written (collectFieldRows marks it).
  const send = (planned) => {
    const docRows = planned.filter((r) => !r.invalid);
    if (!docRows.length) return Promise.resolve([]);
    return client.batched(async (b) => {
      const spanRows = docRows.filter((r) => r.kind !== 'morphForm' && !clears(r));
      const clearRows = docRows.filter(clears);
      const morphRows = docRows.filter((r) => r.kind === 'morphForm');
      for (const part of chunk(spanRows)) {
        b.spans.bulkUpdate(part.map((r) => ({ id: r.id, value: r.new })));
      }
      for (const part of chunk(clearRows)) b.spans.bulkDelete(part.map((r) => r.id));
      for (const part of chunk(morphRows)) {
        b.tokens.bulkUpdate(
          part.map((r) => ({ id: r.id, metadata: [{ op: 'set', path: ['form'], value: r.new }] })),
        );
      }
    });
  };
  await writeAcrossDocuments(client, label, 'replace', async () => {
    const byDoc = rowsByDoc(rows.filter((r) => !r.applied && !r.invalid));
    let n = 0;
    for (const [docId, docRows] of byDoc) {
      onProgress?.((n += 1), byDoc.size);
      const out = await sendDocument(client, {
        docId,
        version: versions?.[docId],
        rows: docRows,
        replan,
        same: sameValue,
        landed: landedValue,
        send,
      }).catch((error) => {
        failed = { docName: docRows[0]?.docName ?? null, error };
        return null;
      });
      if (!out) return;
      docRows.forEach((r) => (r.applied = true));
      changed += out.sent.length;
      cleared += out.sent.filter(clears).length;
      skipped += out.skipped.length;
    }
  });
  return stoppedOrDone(
    { changed, skipped, ...(cleared ? { cleared } : {}), ...(failed ? { failed } : {}) },
    changed,
  );
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
export async function applyReanalyze(
  client,
  { rows, docs },
  { analysis, label, onError, onProgress },
) {
  const docById = new Map(docs.map((d) => [d.id, d]));
  let changed = 0;
  let skipped = 0;
  let failedDoc = null;
  await writeAcrossDocuments(client, label, 'reanalyze', async () => {
    const byDoc = rowsByDoc(rows);
    let at = 0;
    for (const [docId, docRows] of byDoc) {
      onProgress?.((at += 1), byDoc.size);
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
      let head;
      try {
        head = await client.documents.get(docId);
      } catch (e) {
        if (!unreadable(e)) throw e;
        skipped += docRows.length;
        continue;
      }
      if (head?.version !== doc.raw?.version) {
        await doc.reload();
        refused = true;
        n = false;
      } else {
        n = await replace(targets);
      }
      if (n === false && refused) {
        targets = docRows.filter(
          (r) => doc.tokenLookup?.has(r.id) && signatureNow(doc, r.id) === r.signature,
        );
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

// How many links the losing entries have, and in how many documents, for the
// preview's summary: { links, docs, duplicates }. A link over several words
// (a multi-word expression) is one link, as the server counts the links it
// moves. Only documents this person can read are counted, and the merge
// moves the links in the others too. The merge itself reads the links when
// it runs, so this is a count, not a plan.
//
// `duplicates` is how many of those links the merge drops instead of moving,
// by the server's rule: a link on words the survivor, or another link moved
// before it, is already linked to. Links on the same words are in the same
// document, so every duplicate among the links counted here is counted
// here. Zero without a `survivorId`.
export async function planMerge(client, vocabId, loserIds, survivorId = null) {
  // Each link of `itemId` this person can read: link id to its document and
  // the key of the words it is on.
  const linksOf = async (itemId) => {
    const r = await client.query({
      where: [
        ['vocab', '?v', { layer: vocabId }],
        ['=', '?v.id', itemId],
        ['link-item', '?l', '?v'],
        ['link-token', '?l', '?t'],
        ['token', '?t', { doc: { var: '?d' } }],
      ],
      return: { group: ['?d', '?l', '?t'], aggregates: [['count']] },
    });
    const byLink = new Map();
    for (const [docId, linkId, tokenId] of r?.results || []) {
      const id = String(linkId);
      if (!byLink.has(id)) byLink.set(id, { doc: String(docId), tokens: [] });
      byLink.get(id).tokens.push(String(tokenId));
    }
    return [...byLink].map(([id, { doc, tokens }]) => ({
      id,
      doc,
      key: `${doc}\u0000${tokens.sort().join('\u0000')}`,
    }));
  };
  const links = new Map();
  for (const itemId of loserIds) {
    for (const l of await linksOf(itemId)) links.set(l.id, l);
  }
  let duplicates = 0;
  if (survivorId != null && links.size) {
    const seen = new Set((await linksOf(survivorId)).map((l) => l.key));
    for (const { key } of links.values()) {
      if (seen.has(key)) duplicates += 1;
      else seen.add(key);
    }
  }
  const docs = new Set([...links.values()].map((l) => l.doc));
  return { links: links.size, docs: docs.size, duplicates };
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
