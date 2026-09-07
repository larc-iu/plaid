// Run a rewriting system over a project: find the documents whose sentences
// a rule could match (the server search, uncapped, by document), load each
// one, rewrite every sentence locally (engine.js), and turn the differences
// into preview rows (diff.js). Applying the selected rows writes each
// document's changes in atomic batches under ONE client operation, so the
// History drawer shows a single revertable entry per document.
//
// The server search is only discovery: the local matcher decides what a
// sentence matches after every application, and a rule whose pattern the
// query language cannot express visits every document instead.

import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { compileGrew } from '../compile.js';
import { GrewRuntimeError, GrewUnsupportedError } from '../errors.js';
import { graphFromSentence } from './graph.js';
import { rewriteSentence } from './engine.js';
import { diffGraphs } from './diff.js';

// Ops per atomic batch. A batch is one server transaction holding the single
// write lock until it commits, so this bounds how long a concurrent writer
// waits, not just the number of round trips.
const BATCH_CHUNK = 200;

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
  let docIds = await findDocs(client, grs, layerInfo, projectId);
  if (docIds === null) {
    const all = await client.projects.listDocuments(projectId);
    docIds = (all || []).map((d) => d.id);
  }
  const docs = new Map();
  const rows = [];
  let done = 0;
  for (const docId of docIds) {
    onProgress?.(`Loading document ${done + 1} of ${docIds.length}…`);
    const doc = await ConlluDocument.load(client, projectId, docId, { project, user });
    done += 1;
    docs.set(docId, doc);
    const docName = doc.name || docId;
    doc.sentences.forEach((row, sentenceIndex) => {
      const before = graphFromSentence(row);
      const base = { id: row.id, docId, docName, sentenceIndex, text: row.text };
      try {
        const { graph: after, applications } = rewriteSentence(grs, before);
        if (!applications.length) return;
        const { changes, writes, warnings } = diffGraphs(before, after, doc.layerInfo);
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

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// Apply the selected rows, document by document, under one operation.
// Returns { docsChanged, sentencesChanged }.
export async function applyRewrite(client, { rows, docs, label }, onProgress) {
  const byDoc = new Map();
  for (const r of rows) {
    if (!r.writes) continue;
    if (!byDoc.has(r.docId)) byDoc.set(r.docId, []);
    byDoc.get(r.docId).push(r);
  }
  const out = { docsChanged: 0, sentencesChanged: 0 };
  let done = 0;
  await client.withOperation(label, async () => {
    for (const [docId, docRows] of byDoc) {
      onProgress?.(`Applying to document ${done + 1} of ${byDoc.size}…`);
      await applyToDocument(client, docs.get(docId), docRows);
      done += 1;
      out.docsChanged += 1;
      out.sentencesChanged += docRows.length;
    }
  });
  onProgress?.('');
  return out;
}

async function applyToDocument(client, doc, rows) {
  const writer = doc.writer;
  const createStamp = writer.createStamp || undefined;
  // Word → lemma span id, from the sentence graphs plus the spans created below.
  const lemmaOf = new Map();
  for (const r of rows)
    for (const n of r.nodes.values()) if (n.spanIds.lemma) lemmaOf.set(n.id, n.spanIds.lemma);

  // 1. Deleted words (their spans and relations cascade server-side).
  const tokens = rows.flatMap((r) => r.writes.tokens);
  for (const part of chunk(tokens, BATCH_CHUNK)) {
    await client.batched(async () => {
      part.forEach((w) => client.tokens.delete(w.id));
    });
  }

  // 2. Lemma spans the relations below hang on.
  const lemmas = rows.flatMap((r) => r.writes.lemmaCreates);
  for (const part of chunk(lemmas, BATCH_CHUNK)) {
    const results = await client.batched(async () => {
      part.forEach((w) => client.spans.create(w.layer, w.tokens, w.value, createStamp));
    });
    part.forEach((w, i) => lemmaOf.set(w.node, results[i]?.body?.id));
  }

  // 3. Everything else. A person's edit of a machine or contributed value
  // carries the writer's stamp, in the same batch as the value.
  const main = rows.flatMap((r) => r.writes.main);
  for (const part of chunk(main, BATCH_CHUNK)) {
    await client.batched(async () => {
      for (const w of part) {
        switch (w.op) {
          case 'updateSpan': {
            client.spans.update(w.id, w.value);
            const stamp = writer.editStamp(w.metadata);
            if (stamp) client.spans.patchMetadata(w.id, stamp);
            break;
          }
          case 'createSpan':
            client.spans.create(w.layer, w.tokens, w.value, createStamp);
            break;
          case 'deleteSpan':
            client.spans.delete(w.id);
            break;
          case 'updateRelation': {
            client.relations.update(w.id, w.value);
            const stamp = writer.editStamp(w.metadata);
            if (stamp) client.relations.patchMetadata(w.id, stamp);
            break;
          }
          case 'setSource':
            client.relations.setSource(w.id, lemmaOf.get(w.node));
            break;
          case 'setTarget':
            client.relations.setTarget(w.id, lemmaOf.get(w.node));
            break;
          case 'deleteRelation':
            client.relations.delete(w.id);
            break;
          case 'createRelation':
            client.relations.create(
              w.layer,
              lemmaOf.get(w.src),
              lemmaOf.get(w.tgt),
              w.value,
              createStamp,
            );
            break;
          default:
            throw new Error(`Unknown write ${w.op}`);
        }
      }
    });
  }
}
