// A node add, a re-anchor and a triple on a new constant each write the
// anchors they make and what stands on them in ONE batch, the later writes
// naming the anchors by ref (D19). It lands whole or not at all, so a failure
// or a lost answer leaves nothing to take back (REV-F-REPAIR O2). The undo
// these used to send after a failure is gone with them: for a re-anchor
// whose answer was lost it deleted another user's node and its edges
// (58e3996e), and for an add it needed to go without the version claim
// (V4 H4-2). Text mode, whose writes can be too many ops for one request,
// still undoes its anchors, without the claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { DOC_CONSTANTS } from '../src/domain/format/inventory.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'umr',
  'english_umr-0001.umr',
);

// In the browser the usual failure is a lost answer (status 0), which the
// write queue waits out for a minute and more, so the tests fail with a
// server error instead: what is sent after it is the same either way.
const refused = () =>
  Object.assign(new Error('HTTP 500 Internal error'), { status: 500, method: 'POST' });

const load = () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const plan = planImport(parseUmrFile(text).sentences, []);
  const { client, calls, requests } = recordingClient();
  client.strictModeDocumentId = 'doc-1';
  const stamps = [];
  const bulkDelete = client.tokens.bulkDelete;
  client.tokens.bulkDelete = (ids) => {
    stamps.push(client.strictModeDocumentId);
    return bulkDelete(ids);
  };
  const doc = new UmrDocument({ raw: rawFromPlan(plan), client });
  doc.onError = () => {};
  // Held as a screen holds it, and let go at the end, so the queue stops
  // retrying a failed write once the test has read what it sent.
  const release = doc.hold();
  return { doc, client, calls, requests, stamps, release };
};

const failBatches = (client) => {
  client.batched = async () => {
    throw refused();
  };
};

test('a node add under a parent is one request: its anchor, the node on it and its edge', async () => {
  const { doc, calls, requests, release } = load();
  const s1 = doc.sentence(1);
  const parent = s1.nodes[0];
  const result = await doc.createNode({
    sentenceIndex: 1,
    concept: 'die-01',
    wordIds: [s1.words[1].id],
    parentId: parent.id,
    role: ':ARG1',
  });
  assert.ok(result);
  assert.deepEqual(
    requests.map((r) => r.name),
    ['batch'],
  );
  assert.ok(calls.some((c) => c.name === 'tokens.bulkCreate'));
  const span = calls.find((c) => c.name === 'spans.create');
  const edge = calls.find((c) => c.name === 'relations.create');
  // The ids the batch made, filled in where the refs were.
  assert.equal(span.args[1].length, 1);
  assert.match(span.args[1][0], /^new/);
  assert.equal(edge.args[2], result.nodeId);
  assert.match(result.nodeId, /^new/);
  release();
});

test('a node add that failed sends nothing after it', async () => {
  const { doc, client, calls, release } = load();
  failBatches(client);
  const s1 = doc.sentence(1);
  const result = await doc.createNode({
    sentenceIndex: 1,
    concept: 'die-01',
    wordIds: [s1.words[1].id],
  });
  assert.equal(result, false);
  assert.equal(calls.filter((c) => c.name === 'tokens.bulkDelete').length, 0);
  assert.equal(client.strictModeDocumentId, 'doc-1');
  release();
});

test('a re-anchor is one request, the node taking its new anchors by ref', async () => {
  const { doc, calls, requests, release } = load();
  const s1 = doc.sentence(1);
  const node = s1.nodes.find((n) => n.wordIds?.length);
  const other = s1.words.find((w) => !node.wordIds.includes(w.id));
  const oldPieces = node.pieces.map((p) => p.id);
  assert.ok(await doc.setAnchor(node.id, [...node.wordIds, other.id]));
  assert.deepEqual(
    requests.map((r) => r.name),
    ['batch'],
  );
  const setTokens = calls.find((c) => c.name === 'spans.setTokens');
  assert.ok(setTokens.args[1].every((id) => /^new/.test(id)));
  const deleted = calls.find((c) => c.name === 'tokens.bulkDelete');
  assert.deepEqual(deleted.args[0], oldPieces);
  release();
});

// Its answer lost after the server stored it, the batch leaves the node on the
// new anchors. An undo then deleted them, and the node and its edges with
// them (REV-F-REPAIR R1). Nothing is sent after it now.
test('a re-anchor that failed sends nothing after it', async () => {
  const { doc, client, calls, release } = load();
  failBatches(client);
  const s1 = doc.sentence(1);
  const node = s1.nodes.find((n) => n.wordIds?.length);
  const other = s1.words.find((w) => !node.wordIds.includes(w.id));
  await doc.setAnchor(node.id, [...node.wordIds, other.id]);
  assert.equal(calls.filter((c) => c.name === 'tokens.bulkDelete').length, 0);
  assert.equal(client.strictModeDocumentId, 'doc-1');
  release();
});

test('a triple on a constant no triple has used yet is one request', async () => {
  const { doc, calls, requests, release } = load();
  const constant = DOC_CONSTANTS.find((c) => !doc.constantNode(c));
  assert.ok(constant, 'the fixture leaves a constant unused');
  const s1 = doc.sentence(1);
  const node = s1.nodes[0];
  const made = await doc.createTriple({ source: constant, target: node.id, rel: ':modal' });
  assert.ok(made);
  assert.deepEqual(
    requests.map((r) => r.name),
    ['batch'],
  );
  const span = calls.find((c) => c.name === 'spans.create');
  const triple = calls.find((c) => c.name === 'relations.create');
  assert.equal(span.args[2], constant);
  assert.match(span.args[1][0], /^new/);
  assert.match(triple.args[1], /^new/);
  release();
});

// Text mode makes its anchors in one request and the nodes on them in the
// next. When the second fails, the anchors are deleted again without the
// version claim: the first request's answer may have been lost after the
// server stored it, and a claimed delete would be refused and leave them
// (V4 H4-2).
test('Text mode whose nodes failed deletes the anchors it made without a version claim', async () => {
  const { doc, client, calls, stamps, release } = load();
  const batched = client.batched;
  let n = 0;
  client.batched = async (fn) => {
    n += 1;
    if (n === 2) throw refused();
    return batched(fn);
  };
  const text = doc
    .penmanOf(1)
    .replace('(s1l / landslide-01', '(s1l / landslide-01 :mod (s1zz / big)');
  await doc.applyPenman(1, text);
  assert.equal(calls.filter((c) => c.name === 'tokens.bulkDelete').length, 1);
  assert.deepEqual(stamps, [null]);
  assert.equal(client.strictModeDocumentId, 'doc-1');
  release();
});
