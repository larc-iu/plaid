// Every row an edit shows under a minted id is created on the server under
// that id: the anchors, the node, its edge, a constant, a document-level
// relation and what Text mode makes. A create sent again after a lost answer
// then names the same rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { DOC_CONSTANTS } from '../src/domain/format/inventory.js';
import { isPendingId } from '../../plaid-ui/src/domain/pendingIds.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'umr',
  'english_umr-0001.umr',
);

// The document held, so what an edit shows can be read before it is sent.
// `sent` is every id a create named, by what it made.
const load = () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const plan = planImport(parseUmrFile(text).sentences, []);
  const { client, calls } = recordingClient();
  const sent = [];
  const withId = (group, method, idAt) => {
    const original = client[group][method];
    client[group][method] = (...args) => {
      sent.push({ what: `${group}.${method}`, id: args[idAt]?.id });
      return original(...args);
    };
  };
  withId('spans', 'create', 5);
  withId('relations', 'create', 6);
  for (const group of ['tokens', 'spans', 'relations']) {
    const original = client[group].bulkCreate;
    client[group].bulkCreate = (ops) => {
      ops.forEach((op) => sent.push({ what: `${group}.bulkCreate`, id: op.id }));
      return original(ops);
    };
  }
  const doc = new UmrDocument({ raw: rawFromPlan(plan), client });
  doc._reload = async () => {};
  const errors = [];
  doc.onError = (msg, err) => errors.push(err ?? msg);
  const release = doc.hold();
  return { doc, calls, sent, errors, release };
};

// Every pending id the screen shows, read before the edit is sent.
const shownIds = (doc) => {
  const ids = new Set();
  JSON.stringify(doc.raw, (key, value) => {
    if (key === 'id' && isPendingId(value)) ids.add(value);
    return value;
  });
  return ids;
};

// Each create named an id the edit minted and showed.
const assertSentAsShown = (sent, shown, what) => {
  assert.ok(sent.length, `${what}: something was created`);
  sent.forEach((s) => {
    assert.ok(shown.has(s.id), `${what}: ${s.what} sent ${JSON.stringify(s.id)}, not an id shown`);
  });
};

const unrelated = (doc, sentenceIndex) => {
  const nodes = doc.sentence(sentenceIndex).nodes;
  for (const a of nodes) {
    for (const b of nodes) {
      if (a.id !== b.id && !doc.wouldCycle(a.id, b.id, ':mod')) return [a, b];
    }
  }
  throw new Error('No two unrelated nodes');
};

test('a node added under a parent sends the ids of its anchor, itself and its edge', async () => {
  const { doc, sent, errors, release } = load();
  const s1 = doc.sentence(1);
  const parent = s1.nodes[0];
  let shownAs = null;
  const made = doc.createNode({
    sentenceIndex: 1,
    concept: 'big',
    wordIds: [s1.words[0].id],
    parentId: parent.id,
    role: ':mod',
    onShown: (ids) => (shownAs = ids),
  });
  const shown = shownIds(doc);
  release();
  assert.ok(await made, JSON.stringify(errors));
  assertSentAsShown(sent, shown, 'createNode');
  assert.deepEqual(
    sent.map((s) => s.what),
    ['tokens.bulkCreate', 'spans.create', 'relations.create'],
  );
  assert.equal(sent[1].id, shownAs.nodeId);
  assert.equal(sent[2].id, shownAs.edgeId);
});

test('an edge sends the id it is shown under', async () => {
  const { doc, sent, errors, release } = load();
  const [a, b] = unrelated(doc, 1);
  const drawn = doc.createEdge(a.id, b.id, ':mod');
  const shown = shownIds(doc);
  release();
  assert.ok(await drawn, JSON.stringify(errors));
  assertSentAsShown(sent, shown, 'createEdge');
  assert.equal(sent.length, 1);
});

test('a moved edge sends the id of the edge it is remade as', async () => {
  const { doc, sent, errors, release } = load();
  const s1 = doc.sentence(1);
  const edge = s1.edges.find((e) => {
    const other = s1.nodes.find(
      (n) => n.id !== e.source && n.id !== e.target && !doc.wouldCycle(n.id, e.target, e.role),
    );
    return !!other;
  });
  const source = s1.nodes.find(
    (n) =>
      n.id !== edge.source && n.id !== edge.target && !doc.wouldCycle(n.id, edge.target, edge.role),
  );
  const moved = doc.moveEdge(edge.id, source.id);
  const shown = shownIds(doc);
  release();
  assert.ok(await moved, JSON.stringify(errors));
  assertSentAsShown(sent, shown, 'moveEdge');
  assert.equal(sent.length, 1);
});

test('a document-level relation on a new constant sends the ids of the constant and itself', async () => {
  const { doc, sent, errors, release } = load();
  const node = doc.sentence(1).nodes[0];
  const constant = DOC_CONSTANTS.find((c) => !doc.constantNode(c));
  assert.ok(constant, 'a constant the fixture does not use yet');
  const made = doc.createTriple({ source: node.id, target: constant, rel: ':before' });
  const shown = shownIds(doc);
  release();
  assert.ok(await made, JSON.stringify(errors));
  assertSentAsShown(sent, shown, 'createTriple');
  assert.deepEqual(
    sent.map((s) => s.what),
    ['tokens.bulkCreate', 'spans.create', 'relations.create'],
  );
});

test('a Text mode apply sends the ids of the anchors, nodes and edges it shows', async () => {
  const { doc, sent, errors, release } = load();
  const s1 = doc.sentence(1);
  const root = s1.nodes.find((n) => n.root) || s1.nodes[0];
  const head = `(${root.var} / ${root.concept}`;
  const text = doc
    .penmanOf(1)
    .replace(head, `${head} :mod (${root.var.replace(/[a-z]+\d*$/, '')}zz / big)`);
  const applied = doc.applyPenman(1, text);
  const shown = shownIds(doc);
  release();
  assert.ok(await applied, JSON.stringify(errors));
  assertSentAsShown(sent, shown, 'applyPenman');
  assert.deepEqual(
    [...new Set(sent.map((s) => s.what))],
    ['tokens.bulkCreate', 'spans.bulkCreate', 'relations.bulkCreate'],
  );
});
