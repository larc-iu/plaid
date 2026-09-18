// The document's edits against a recording client: what each one sends, and
// that the optimistic patch leaves the graph as the server would return it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './storageRoundTrip.test.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'umr',
  'english_umr-0001.umr',
);

// A client that answers every write with fresh ids and remembers the calls.
// `batched` runs the queued ops in order and answers like the server: one
// `{ body }` per op.
function recordingClient() {
  let n = 0;
  const id = () => `new${++n}`;
  const calls = [];
  const record = (name, ...args) => calls.push({ name, args });
  const api = {
    tokens: {
      bulkCreate: async (ops) => {
        record('tokens.bulkCreate', ops);
        return { ids: ops.map(() => id()) };
      },
      bulkDelete: async (ids) => record('tokens.bulkDelete', ids),
    },
    spans: {
      create: async (layer, tokens, value, metadata) => {
        record('spans.create', layer, tokens, value, metadata);
        return { id: id() };
      },
      update: async (spanId, value) => record('spans.update', spanId, value),
      patchMetadata: async (spanId, patch) => record('spans.patchMetadata', spanId, patch),
      setTokens: async (spanId, tokens) => record('spans.setTokens', spanId, tokens),
    },
    relations: {
      create: async (layer, source, target, value, metadata) => {
        record('relations.create', layer, source, target, value, metadata);
        return { id: id() };
      },
      update: async (relId, value) => record('relations.update', relId, value),
      delete: async (relId) => record('relations.delete', relId),
    },
    withOperation: async (label, fn) => {
      record('operation', label);
      return fn(() => {});
    },
    batched: async (fn) => {
      const queue = [];
      const proxy = (group) =>
        new Proxy(
          {},
          {
            get:
              (_, method) =>
              (...args) =>
                queue.push(() => api[group][method](...args)),
          },
        );
      await fn({ tokens: proxy('tokens'), spans: proxy('spans'), relations: proxy('relations') });
      const out = [];
      for (const op of queue) out.push({ body: await op() });
      return out;
    },
  };
  return { client: api, calls };
}

const load = () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const plan = planImport(parseUmrFile(text).sentences, []);
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({ raw: rawFromPlan(plan), client });
  doc.onError = (msg) => {
    throw new Error(msg);
  };
  return { doc, calls };
};

const byVar = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);

test('createNode anchors to the words, joins the parent and gets a fresh variable', async () => {
  const { doc, calls } = load();
  const s1 = doc.sentence(1);
  const root = s1.roots[0];
  const word = s1.words[1];
  const before = s1.nodes.length;
  const result = await doc.createNode({
    sentenceIndex: 1,
    concept: 'die-01',
    wordIds: [word.id],
    parentId: root.id,
    role: ':ARG2',
  });
  assert.ok(result.nodeId && result.edgeId);
  const s = doc.sentence(1);
  assert.equal(s.nodes.length, before + 1);
  const node = doc.node(result.nodeId);
  assert.equal(node.concept, 'die-01');
  // s1d is taken by the corpus, so the next free one.
  assert.equal(node.var, 's1d2');
  assert.deepEqual(node.wordIds, [word.id]);
  assert.equal(node.in[0].role, ':ARG2');
  assert.equal(node.in[0].source, root.id);
  const names = calls.map((c) => c.name);
  assert.deepEqual(names, ['operation', 'tokens.bulkCreate', 'spans.create', 'relations.create']);
  assert.equal(calls[1].args[0][0].begin, word.begin);
  assert.equal(calls[1].args[0][0].end, word.end);
});

test('an abstract node in a sentence with a root is a fragment, not a root', async () => {
  const { doc } = load();
  const result = await doc.createNode({ sentenceIndex: 1, concept: 'person' });
  const node = doc.node(result.nodeId);
  assert.equal(node.aligned, false);
  assert.equal(node.root, false);
  assert.equal(doc.sentence(1).roots.length, 2);
});

test('setAnchor makes the new pieces before the span takes them', async () => {
  const { doc, calls } = load();
  const s1 = doc.sentence(1);
  const node = s1.nodes.find((n) => n.aligned);
  const other = s1.words.find((w) => !node.wordIds.includes(w.id));
  const oldPieceIds = node.pieces.map((p) => p.id);
  assert.equal(await doc.setAnchor(node.id, [other.id]), true);
  assert.deepEqual(doc.node(node.id).wordIds, [other.id]);
  const names = calls.map((c) => c.name);
  assert.deepEqual(names, [
    'operation',
    'tokens.bulkCreate',
    'spans.setTokens',
    'tokens.bulkDelete',
  ]);
  assert.deepEqual(calls[3].args[0], oldPieceIds);
  // Adjacent words make one piece, a gap makes two.
  const [w1, w2, , w4] = s1.words;
  await doc.setAnchor(node.id, [w1.id, w2.id, w4.id]);
  const pieces = doc.node(node.id).pieces;
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].begin, w1.begin);
  assert.equal(pieces[0].end, w2.end);
});

test('createEdge refuses a cycle unless it is a quote', async () => {
  const { doc } = load();
  const s1 = doc.sentence(1);
  const root = s1.roots[0];
  const child = doc.node(root.out[0].target);
  let refused = null;
  doc.onError = (msg) => {
    refused = msg;
  };
  assert.equal(await doc.createEdge(child.id, root.id, ':ARG0'), false);
  assert.match(refused, /cycle/);
  const edgeId = await doc.createEdge(child.id, root.id, ':quote');
  assert.ok(edgeId);
  // The root is still the root, the new edge is re-entrant on the canvas.
  assert.equal(doc.sentence(1).roots[0].id, root.id);
});

test('deleteEdge takes the nodes only that edge reached, and spares a re-entrant one', async () => {
  const { doc, calls } = load();
  // Sentence 1: override-91 :ARG1 landslide-01 :place country :name name.
  const landslide = byVar(doc, 's1l');
  const country = byVar(doc, 's1c');
  const placeEdge = landslide.out.find((e) => e.target === country.id);
  const doomed = doc.exclusiveDescendants(placeEdge.id).map((n) => n.var);
  assert.deepEqual(doomed.sort(), ['s1c', 's1n']);
  const deleted = await doc.deleteEdge(placeEdge.id);
  assert.equal(deleted, 2);
  assert.equal(byVar(doc, 's1c'), undefined);
  assert.equal(byVar(doc, 's1n'), undefined);
  assert.equal(
    byVar(doc, 's1l').out.some((e) => e.id === placeEdge.id),
    false,
  );
  const del = calls.find((c) => c.name === 'tokens.bulkDelete');
  assert.equal(del.args[0].length, 2);
});

test('moveEdge re-parents in one batch and keeps the role', async () => {
  const { doc, calls } = load();
  const landslide = byVar(doc, 's1l');
  const country = byVar(doc, 's1c');
  const and = byVar(doc, 's1a');
  const placeEdge = landslide.out.find((e) => e.target === country.id);
  assert.equal(await doc.moveEdge(placeEdge.id, and.id), true);
  const moved = byVar(doc, 's1c').in[0];
  assert.equal(moved.source, and.id);
  assert.equal(moved.role, ':place');
  assert.deepEqual(
    calls.map((c) => c.name),
    ['operation', 'relations.delete', 'relations.create'],
  );
});

test('setRoot moves the mark and the export follows it', async () => {
  const { doc } = load();
  const s1 = doc.sentence(1);
  const oldRoot = s1.roots[0];
  const landslide = byVar(doc, 's1l');
  assert.equal(await doc.setRoot(landslide.id), true);
  assert.equal(doc.sentence(1).roots[0].id, landslide.id);
  assert.equal(doc.node(oldRoot.id).root, false);
  assert.match(doc.toUmr(), /# sentence level graph:\n\(s1l \/ landslide-01/);
});

test('setVariable refuses a taken or malformed variable', async () => {
  const { doc } = load();
  const landslide = byVar(doc, 's1l');
  let refused = null;
  doc.onError = (msg) => {
    refused = msg;
  };
  assert.equal(await doc.setVariable(landslide.id, 's1c'), false);
  assert.match(refused, /in use/);
  assert.equal(await doc.setVariable(landslide.id, 'x1'), false);
  assert.equal(await doc.setVariable(landslide.id, 's1z9'), true);
  assert.equal(byVar(doc, 's1z9').concept, 'landslide-01');
});

test('setAttrs restates the whole umr namespace', async () => {
  const { doc, calls } = load();
  const landslide = byVar(doc, 's1l');
  await doc.setAttrs(landslide.id, [{ rel: ':aspect', value: 'process' }]);
  const patch = calls.find((c) => c.name === 'spans.patchMetadata').args[1];
  assert.equal(patch.umr.var, 's1l');
  assert.deepEqual(patch.umr.attrs, [{ rel: ':aspect', value: 'process', order: 0 }]);
  assert.match(doc.toUmr(), /:aspect process/);
});
