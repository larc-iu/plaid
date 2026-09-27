// Run a rewriting system over a project: find the documents whose sentences
// a rule could match (the server search, uncapped, by document), load each
// one, rewrite every sentence locally (engine.js), and turn the differences
// into preview rows (diff.js). Applying the selected rows writes each
// document's changes in one atomic batch where it can (see applyToDocument),
// all under ONE client operation, so the History drawer shows a single
// revertable entry per document.
//
// The server search is only discovery: the local matcher decides what a
// sentence matches after every application, and a rule whose pattern the
// query language cannot express visits every document instead.

import { metadataOps, createdId, MAX_BATCH_OPS } from '@larc-iu/plaid-client';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { compileGrew } from '../compile.js';
import { GrewRuntimeError, GrewUnsupportedError } from '../errors.js';
import { graphFromSentence } from './graph.js';
import { rewriteSentence } from './engine.js';
import { diffGraphs } from './diff.js';
import { bareLabel } from '../edgeLabel.js';
import { makeValidators } from '../../utils/udVocabMode.js';

// Document GETs in flight at once. Measured on a 1172-document project: four
// in flight load about three times faster than one at a time, and eight or
// sixteen gain nothing more (the server is the ceiling), so four it is.
const LOAD_CONCURRENCY = 4;

// Document ids with at least one server-side match for any rule, busiest
// first, or null when some rule has to be matched everywhere.
async function findDocs(client, grs, layerInfo, projectId) {
  const counts = new Map();
  for (const rule of grs.rules) {
    let compiled;
    try {
      compiled = compileGrew(rule, layerInfo, { projectId });
    } catch (e) {
      if (e instanceof GrewUnsupportedError) return null;
      throw e;
    }
    if (compiled.impossible) continue;
    // A rule whose query cannot find everything the matcher can (a root from
    // a named head, a form inside a multiword token): the list of documents
    // it gives is short of the ones whose only match is one of those. Read
    // them all.
    if (compiled.partialDocs) return null;
    const r = await client.query({
      where: [...compiled.query.where, ['token', '?S', { doc: { var: '?d' } }]],
      return: { group: ['?d'], aggregates: [['count']] },
      scope: { projectIds: [projectId] },
    });
    for (const [docId, n] of r?.results || []) {
      counts.set(String(docId), (counts.get(String(docId)) || 0) + n);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// Preview rows for `grs` over the project. Each row is one sentence with at
// least one rule application: { id, docId, docName, text, applications,
// changes, warnings, error, writes, nodes }. `docs` maps document id to the
// loaded ConlluDocument (the apply step writes as its `writer`).
export async function planRewrite(client, { project, user, layerInfo, grs }, onProgress) {
  const projectId = project.id;
  const validators = makeValidators(layerInfo);
  let docIds = await findDocs(client, grs, layerInfo, projectId);
  if (docIds === null) {
    const all = await client.projects.listDocuments(projectId);
    docIds = (all || []).map((d) => d.id);
  }
  const docs = new Map();
  const rows = [];
  let loaded = 0;
  onProgress?.(`Loading document 1 of ${docIds.length}…`);
  const loading = mapPool(docIds, LOAD_CONCURRENCY, async (docId) => {
    const doc = await ConlluDocument.load(client, projectId, docId, { project, user });
    loaded += 1;
    if (loaded < docIds.length) onProgress?.(`Loading document ${loaded + 1} of ${docIds.length}…`);
    return doc;
  });
  // Rewrite each document as soon as it arrives, in discovery order.
  for (let i = 0; i < docIds.length; i++) {
    const docId = docIds[i];
    const doc = await loading[i];
    docs.set(docId, doc);
    const docName = doc.name || docId;
    doc.sentences.forEach((row, sentenceIndex) => {
      const before = graphFromSentence(row);
      const base = { id: row.id, docId, docName, sentenceIndex, text: row.text };
      try {
        const { graph: after, applications } = rewriteSentence(grs, before);
        if (!applications.length) return;
        // A CLOSED vocabulary refuses the row rather than the run: the rest of
        // the corpus still rewrites, and the preview says which sentence and
        // why. This and the annotation cells are the only two places a closed
        // list is enforced: an import, a service, the assistant and the API
        // all still get through, which is what the Validation tab is for.
        const refusal = offVocabulary(before, after, validators);
        if (refusal) {
          rows.push({
            ...base,
            applications: 0,
            changes: [],
            warnings: [],
            writes: null,
            nodes: before.nodes,
            error: refusal,
          });
          return;
        }
        const { changes, writes, warnings } = diffGraphs(before, after, doc.layerInfo);
        // A rule can apply and leave nothing to do: an `E:` edge the tree
        // already gives the enhanced graph is one. That is not a change. A
        // write with no line of its own (a stale suppressor swept up) still
        // makes a row, since dropping the row would drop the write.
        const idle =
          !changes.length &&
          !writes.main.length &&
          !writes.tokens.length &&
          !writes.lemmaCreates.length;
        if (idle) return;
        rows.push({
          ...base,
          applications: applications.length,
          changes,
          warnings,
          writes,
          nodes: before.nodes,
          error: null,
        });
      } catch (e) {
        if (!(e instanceof GrewRuntimeError)) throw e;
        rows.push({
          ...base,
          applications: 0,
          changes: [],
          warnings: [],
          writes: null,
          nodes: before.nodes,
          error: e.message,
        });
      }
    });
  }
  onProgress?.('');
  return { rows, docs, documentsVisited: docIds.length };
}

// The first value THIS RULE WRITES that a closed vocabulary refuses, as the
// message the preview shows on that row, or null when everything it writes is
// legal. Reports ONE: a rule that produces an illegal tag usually produces it
// everywhere, and a row listing forty of them says nothing the first does not.
//
// Only what changed. Walking the whole rewritten sentence meant that one
// parser-written off-list value anywhere in it blocked a rule that never
// touched that column, which is neither what the rule did nor something the
// annotator can fix from the preview.
function offVocabulary(before, after, validators) {
  for (const id of after.order) {
    const node = after.nodes.get(id);
    if (!node || node.deleted || node.anchor) continue;
    const was = before.nodes?.get(id) || null;
    for (const [col, check] of [
      ['upos', validators.upos],
      ['xpos', validators.xpos],
    ]) {
      if (node[col] == null || (was && was[col] === node[col])) continue;
      const refusal = check(node[col]);
      if (refusal) return `${node.form}: ${refusal}`;
    }
    // `feats` is a Map on a real node, so iterate rather than mapping it.
    const had = new Set();
    for (const [k, v] of was?.feats || []) had.add(`${k}=${v}`);
    for (const [key, value] of node.feats || []) {
      const pair = `${key}=${value}`;
      if (had.has(pair)) continue;
      const refusal = validators.feats(pair);
      if (refusal) return `${node.form}: ${refusal}`;
    }
  }
  // `edges` is a Map keyed by relation id.
  for (const [id, edge] of after.edges?.entries() || []) {
    if (edge.label == null || before.edges?.get(id)?.label === edge.label) continue;
    const refusal = validators.deprel(bareLabel(edge.label));
    if (refusal) return refusal;
  }
  return null;
}

// `fn` over `items` with at most `limit` in flight; one promise per item, in
// order, so a consumer can await them as they come.
function mapPool(items, limit, fn) {
  const results = [];
  let next = 0;
  const resolvers = items.map(
    () =>
      new Promise((resolve, reject) => {
        results.push({ resolve, reject });
      }),
  );
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i].resolve(await fn(items[i]));
      } catch (e) {
        results[i].reject(e);
      }
    }
  };
  for (let k = 0; k < Math.min(limit, items.length); k++) worker();
  return resolvers;
}

// Apply the selected rows, document by document, under one operation. Each
// document is written in the client's strict mode, so every batch carries the
// document version the preview loaded: a document someone changed since then
// is refused by the server (409) before anything in it is touched. The run
// stops at the first document that fails; the ones before it stay applied.
// Returns { docsChanged, sentencesChanged, failed }, where `failed` is
// { docId, docName, status, message, partial } or null. `partial` is true
// when some of that document's writes landed and could not be taken back.
export async function applyRewrite(client, { rows, docs, label }, onProgress) {
  const byDoc = new Map();
  for (const r of rows) {
    if (!r.writes) continue;
    if (!byDoc.has(r.docId)) byDoc.set(r.docId, []);
    byDoc.get(r.docId).push(r);
  }
  const out = { docsChanged: 0, sentencesChanged: 0, failed: null };
  let done = 0;
  await client.withOperation(label, async () => {
    for (const [docId, docRows] of byDoc) {
      onProgress?.(`Applying to document ${done + 1} of ${byDoc.size}…`);
      client.enterStrictMode(docId);
      try {
        await applyToDocument(client, docId, docs.get(docId), docRows);
      } catch (e) {
        out.failed = {
          docId,
          docName: docRows[0].docName,
          status: e?.status ?? null,
          message: e?.message || String(e),
          partial: Boolean(e?.partial),
        };
        break;
      } finally {
        client.exitStrictMode();
      }
      done += 1;
      out.docsChanged += 1;
      out.sentencesChanged += docRows.length;
    }
  });
  onProgress?.('');
  return out;
}

// The toast after an apply. `reason` turns the failure into a sentence, and
// its own full stop is dropped so the sentence can end here.
export function applySummary(out, reason) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const applied = `${plural(out.sentencesChanged, 'sentence')} in ${plural(out.docsChanged, 'document')}`;
  if (!out.failed) return `Changed ${applied}.`;
  const { docName, status, partial } = out.failed;
  const why = (status === 409 ? 'it changed since the preview' : reason(out.failed))
    .trim()
    .replace(/\.+$/, '');
  const parts = [`Stopped at ${docName}: ${why}.`];
  parts.push(partial ? `${docName} is partly changed.` : `${docName} is unchanged.`);
  if (out.docsChanged) parts.push(`Changed ${applied} before it.`);
  return parts.join(' ');
}

// A document's writes go as ONE batch whenever they can: the words deleted
// first, then every span and relation write, in one transaction, so a refusal
// leaves the document as it was. Two cases cannot be one transaction. A
// relation that needs a lemma span created for it names that span's id, which
// only the server hands out, so the lemma spans go first in a batch of their
// own. And a batch past MAX_BATCH_OPS is sent as consecutive requests. Either
// way the document lock is held across the requests so no one else writes in
// between, and when the second batch is refused whole, the lemma spans the
// first created are deleted again. A refusal that leaves writes behind is
// thrown with `partial` set.
async function applyToDocument(client, docId, doc, rows) {
  const writer = doc.writer;
  const createStamp = writer.createStamp || undefined;
  // Word → lemma span id, from the sentence graphs plus the spans created below.
  const lemmaOf = new Map();
  for (const r of rows)
    for (const n of r.nodes.values()) if (n.spanIds.lemma) lemmaOf.set(n.id, n.spanIds.lemma);

  const tokens = rows.flatMap((r) => r.writes.tokens);
  const lemmas = rows.flatMap((r) => r.writes.lemmaCreates);
  const main = rows.flatMap((r) => r.writes.main);

  const queueChanges = (b) => {
    // Deleted words first (their spans and relations cascade server-side).
    tokens.forEach((w) => b.tokens.delete(w.id));
    queueMain(b, main, writer, createStamp, lemmaOf);
  };

  // An update may carry a stamp beside it, so a main write is at most two ops.
  const changeOps = tokens.length + 2 * main.length;
  if (!lemmas.length && changeOps <= MAX_BATCH_OPS) {
    await client.batched(queueChanges);
    return;
  }

  await client.documents.locked(docId, async () => {
    let created = [];
    if (lemmas.length) {
      let results;
      try {
        results = await client.batched(async (b) => {
          lemmas.forEach((w) => b.spans.create(w.layer, w.tokens, w.value, createStamp));
        });
      } catch (e) {
        // Past MAX_BATCH_OPS the requests before the refused one landed.
        if (lemmas.length > MAX_BATCH_OPS) e.partial = true;
        throw e;
      }
      created = lemmas.map((w, i) => createdId(results[i]));
      lemmas.forEach((w, i) => lemmaOf.set(w.node, created[i]));
    }
    try {
      await client.batched(queueChanges);
    } catch (e) {
      // Past MAX_BATCH_OPS some of the requests may have landed, and the
      // lemma spans cannot be taken back from under them.
      let partial = changeOps > MAX_BATCH_OPS;
      if (!partial && created.length) {
        try {
          await client.batched(async (b) => {
            created.forEach((id) => b.spans.delete(id));
          });
        } catch {
          partial = true;
        }
      }
      if (partial) e.partial = true;
      throw e;
    }
  });
}

// Every span and relation write. A person's edit of a machine or contributed
// value carries the writer's stamp, in the same batch as the value.
function queueMain(b, main, writer, createStamp, lemmaOf) {
  for (const w of main) {
    switch (w.op) {
      case 'updateSpan': {
        b.spans.update(w.id, w.value);
        const stamp = writer.editStamp(w.metadata);
        if (stamp) b.spans.patchMetadata(w.id, metadataOps(stamp));
        break;
      }
      case 'createSpan':
        b.spans.create(w.layer, w.tokens, w.value, createStamp);
        break;
      case 'deleteSpan':
        b.spans.delete(w.id);
        break;
      case 'updateRelation': {
        b.relations.update(w.id, w.value);
        const stamp = writer.editStamp(w.metadata);
        if (stamp) b.relations.patchMetadata(w.id, metadataOps(stamp));
        break;
      }
      case 'setSource':
        b.relations.setSource(w.id, lemmaOf.get(w.node));
        break;
      case 'setTarget':
        b.relations.setTarget(w.id, lemmaOf.get(w.node));
        break;
      case 'deleteRelation':
        b.relations.delete(w.id);
        break;
      case 'createRelation':
        b.relations.create(
          w.layer,
          lemmaOf.get(w.src),
          lemmaOf.get(w.tgt),
          w.value,
          // A suppressor is a statement about the graph and carries its
          // own metadata, never a provenance stamp.
          'metadata' in w ? w.metadata : createStamp,
        );
        break;
      default:
        throw new Error(`Unknown write ${w.op}`);
    }
  }
}
