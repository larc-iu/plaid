// Text mode sends a whole apply as ONE batch: the anchors, the nodes on
// them by ref, the edges on the nodes by ref, with every change and deletion
// ahead of them. A failure anywhere leaves nothing applied (REV-W-FINAL O1,
// where the deletions of the first of three requests stayed stored under
// "Failed to apply the text"). Only an apply past one request's ops goes in
// three, and a failure after the first of them says what stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_BATCH_OPS } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'umr',
  'english_umr-0001.umr',
);

const refused = () =>
  Object.assign(new Error('HTTP 500 Internal error'), { status: 500, method: 'POST' });
const lost = () =>
  Object.assign(new Error('Failed to fetch'), { status: 0, method: 'POST', url: '/api/v1/batch' });

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
  doc._reload = async () => {};
  const errors = [];
  doc.onError = (msg, err) => errors.push({ msg, err });
  const release = doc.hold();
  return { doc, client, calls, requests, stamps, errors, release };
};

// Batch number `k` (from 1) fails with `error`, the rest go through.
const failBatch = (client, k, error) => {
  const batched = client.batched;
  let n = 0;
  client.batched = async (fn) => {
    n += 1;
    if (n === k) throw error;
    return batched(fn);
  };
};

// The fixture's first sentence with a new node under its root: an anchor,
// a node on it and an edge to it.
const reshaped = (doc) => {
  const s1 = doc.sentence(1);
  const root = s1.nodes.find((n) => n.root) || s1.nodes[0];
  const text = doc.penmanOf(1);
  const head = `(${root.var} / ${root.concept}`;
  assert.ok(text.startsWith(head), text);
  return text.replace(head, `${head} :mod (${root.var.replace(/[a-z]+\d*$/, '')}zz / big)`);
};

test('a Text mode apply that makes nodes and edges is one request, naming them by ref', async () => {
  const { doc, calls, requests, release } = load();
  const text = reshaped(doc);
  const plan = doc.planPenman(1, text);
  assert.equal(plan.create.length, 1);
  assert.equal(await doc.applyPenman(1, text), plan.changes);
  assert.deepEqual(
    requests.map((r) => r.name),
    ['batch'],
  );
  const pieces = calls.find((c) => c.name === 'tokens.bulkCreate');
  const nodes = calls.find((c) => c.name === 'spans.bulkCreate');
  const edges = calls.find((c) => c.name === 'relations.bulkCreate');
  assert.ok(pieces && nodes && edges);
  // The ids the batch made, filled in where the refs were.
  assert.match(nodes.args[0][0].tokens[0], /^new/);
  assert.match(edges.args[0][0].target, /^new/);
  const zz = [...doc.graph.nodesById.values()].find((n) => n.concept === 'big');
  assert.equal(edges.args[0][0].target, zz.id, 'the edge names the node the batch made');
  assert.ok(
    !calls.some((c) => c.name === 'tokens.bulkDelete' && c.args[0].includes(zz.pieces[0].id)),
  );
  release();
});

// A lost answer is not a failure: the apply is sent again from the top under
// the same Idempotency-Keys until it is answered (DocumentModel's queue), so
// what landed is answered from what it stored and the rest runs.
test('a Text mode apply whose answer was lost is sent again and applies', async () => {
  const { doc, client, errors, release } = load();
  doc._writes._retryDelay = () => 0;
  failBatch(client, 1, lost());
  const text = reshaped(doc);
  const plan = doc.planPenman(1, text);
  assert.equal(await doc.applyPenman(1, text), plan.changes);
  assert.equal(errors.length, 0);
  release();
});

for (const [what, error] of [['refused', refused]]) {
  test(`a Text mode apply that fails (${what}) sends nothing after it and says it failed`, async () => {
    const { doc, client, calls, requests, errors, release } = load();
    failBatch(client, 1, error());
    const text = reshaped(doc);
    assert.equal(await doc.applyPenman(1, text), false);
    assert.equal(requests.length, 0, 'the one batch was all it sent');
    assert.equal(calls.filter((c) => c.name === 'tokens.bulkDelete').length, 0);
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0].msg, /Partly applied/);
    assert.equal(errors[0].err.status, error().status);
    release();
  });
}

// A sentence of MAX_BATCH_OPS + 1 nodes, each with an attribute, and a
// text that changes every attribute and adds a node with its edge: one op
// per changed node, past one request.
const big = async () => {
  const loaded = load();
  const { doc } = loaded;
  const n = MAX_BATCH_OPS + 1;
  const kids = (value) =>
    Array.from({ length: n }, (_, i) => `    :op${i + 1} (s1t${i} / thing :refer-number ${value})`);
  const first = `(s1l / landslide-01\n${kids('singular').join('\n')})`;
  assert.ok(await doc.applyPenman(1, first));
  loaded.calls.length = 0;
  loaded.requests.length = 0;
  loaded.stamps.length = 0;
  const text = `(s1l / landslide-01\n${kids('plural').join('\n')}\n    :mod (s1zz / big))`;
  const plan = doc.planPenman(1, text);
  assert.equal(plan.create.length, 1);
  assert.ok(plan.attrs.length > MAX_BATCH_OPS);
  return { ...loaded, text };
};

test('an apply past one request goes as three, and lands whole when all three do', async () => {
  const { doc, text, requests, release } = await big();
  assert.ok(await doc.applyPenman(1, text));
  // The first is split past MAX_BATCH_OPS by the client itself, so it is
  // one `batched` here, then the nodes, then the edges.
  assert.deepEqual(
    requests.map((r) => r.name),
    ['batch', 'batch', 'batch'],
  );
  assert.ok(doc.node([...doc.graph.nodesById.values()].find((x) => x.concept === 'big').id));
  release();
});

test('past one request, a failed node request deletes its anchors without a version claim and says what stands', async () => {
  const { doc, client, calls, stamps, errors, text, release } = await big();
  failBatch(client, 2, refused());
  assert.equal(await doc.applyPenman(1, text), false);
  assert.equal(calls.filter((c) => c.name === 'tokens.bulkDelete').length, 1);
  assert.deepEqual(stamps, [null]);
  assert.equal(client.strictModeDocumentId, 'doc-1');
  assert.equal(errors.length, 1);
  assert.match(
    errors[0].msg,
    /Partly applied\. Saved: deletions and changes\. Not saved: new nodes and edges\./,
  );
  release();
});

test('past one request, a failed edge request says the nodes stand', async () => {
  for (const [error, missing] of [[refused, 'Not saved']]) {
    const { doc, client, calls, errors, text, release } = await big();
    failBatch(client, 3, error());
    assert.equal(await doc.applyPenman(1, text), false);
    assert.equal(calls.filter((c) => c.name === 'tokens.bulkDelete').length, 0);
    assert.equal(errors.length, 1);
    assert.match(
      errors[0].msg,
      new RegExp(
        `Partly applied\\. Saved: deletions, changes and new nodes\\. ${missing}: new edges\\.`,
      ),
    );
    release();
  }
});

test('past one request, a first request that failed with nothing saved says it failed, not partly', async () => {
  const { doc, client, errors, text, release } = await big();
  failBatch(client, 1, refused());
  assert.equal(await doc.applyPenman(1, text), false);
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0].msg, /Partly applied/);
  release();
});

test('past one request, a first request that failed after some of it was saved says so', async () => {
  const { doc, client, errors, text, release } = await big();
  failBatch(client, 1, Object.assign(refused(), { committed: MAX_BATCH_OPS }));
  assert.equal(await doc.applyPenman(1, text), false);
  assert.match(
    errors[0].msg,
    /Partly applied\. Saved: some deletions and changes\. Not saved: the rest\./,
  );
  release();
});

// REV-W-LAST: a node request whose answer was lost may have stored the nodes.
// It is sent again under its key, so the nodes stand once, and their anchors
// are never taken away under them.
test('past one request, a node request whose answer was lost is sent again, and its anchors stay', async () => {
  const { doc, client, calls, errors, text, release } = await big();
  doc._writes._retryDelay = () => 0;
  failBatch(client, 2, lost());
  assert.ok(await doc.applyPenman(1, text));
  assert.equal(calls.filter((c) => c.name === 'tokens.bulkDelete').length, 0);
  assert.equal(errors.length, 0);
  release();
});
