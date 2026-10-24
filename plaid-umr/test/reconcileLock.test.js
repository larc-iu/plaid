// Reconcile on open and the document lock a service takes while it rewrites
// the document (the Draft service does): an open while the lock is held
// repairs nothing and reports no failure, and the next open repairs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';
import { PlaidClient } from '@larc-iu/plaid-client';

const TEXT = `${'#'.repeat(80)}
# :: snt1
Index: 1 2 3
Words: Ali geldi .

# sentence level graph:
(s1g / gel-01
    :ARG1 (s1a / person))

# alignment:
s1g: 2-2
s1a: 1-1

# document level annotation:
(s1s0 / sentence)
`;

// A document with something to repair: a variable whose sentence number is
// not its sentence's, as IGT leaves one when it removes a sentence before
// it.
function open(lock) {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  const nodes = raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
  const person = nodes.spanLayers[0].spans.find((x) => x.metadata.umr.var === 's1a');
  person.metadata.umr.var = 's2a';
  const { client, calls } = recordingClient();
  client.documents = { ...client.documents, checkLock: async () => lock() };
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  return { doc, calls };
}

test('an open while a service holds the lock repairs nothing and reports no failure', async () => {
  const { doc, calls } = open(() => ({ userId: 'service@x.com', expiresAt: 1 }));
  const result = await doc._reconcile();
  assert.deepEqual(result, { findings: [], deferred: true });
  assert.equal(calls.length, 0);
  assert.equal(doc.describeReconcile(result), null);
});

test('the next open, with the lock gone, repairs', async () => {
  const { doc, calls } = open(() => null);
  const result = await doc._reconcile();
  assert.equal(result.renumbered, 1);
  assert.deepEqual(calls.find((c) => c.name === 'spans.patchMetadata').args[1], [
    { op: 'set', path: ['umr', 'var'], value: 's1a' },
  ]);
});

test('a lock taken after the check is a deferral too, not a failure', async () => {
  const { doc } = open(() => null);
  doc._client.batched = async () => {
    throw Object.assign(new Error('Document is locked by another user'), { status: 423 });
  };
  assert.deepEqual(await doc._reconcile(), { findings: [], deferred: true, interrupted: true });
});

test('a repair a lock cuts off part way leaves what it wrote under its own label', async () => {
  // Past 1000 operations a batch goes as several requests. The first lands,
  // a service takes the lock, and the second is refused.
  const { doc } = open(() => null);
  const group = { id: 'g1', message: 'Repair on open', depth: 1, written: false };
  doc._client.operationGroup = group;
  const stamped = [];
  doc._client.batched = async () => {
    stamped.push(group.message);
    throw Object.assign(new Error('Document is locked by another user'), {
      status: 423,
      committed: 1000,
    });
  };
  assert.deepEqual(await doc._reconcile(), { findings: [], deferred: true, interrupted: true });
  assert.deepEqual(stamped, ['Repaired: renumbered 1 variable to match the sentences']);
});

// The client's own operation grouping, on the recording client: the label the
// History entry ends with is the group's first message, or the relabel sent
// when the operation ends.
function grouped(client) {
  const relabels = [];
  for (const m of ['beginOperation', 'endOperation', 'withOperation']) {
    client[m] = PlaidClient.prototype[m].bind(client);
  }
  client.operationGroup = null;
  client.operationGroups = { update: async (id, message) => relabels.push(message) };
  return relabels;
}

for (const [name, failure] of [
  ['a lock', { status: 423 }],
  ['any other error', { status: 500 }],
]) {
  test(`a repair ${name} cuts off after writing part of it is labeled as interrupted`, async () => {
    const { doc } = open(() => null);
    const relabels = grouped(doc._client);
    const firstLabel = [];
    doc._client.batched = async () => {
      doc._client.operationGroup.written = true;
      firstLabel.push(doc._client.operationGroup.message);
      throw Object.assign(new Error('refused'), { ...failure, committed: 1000 });
    };
    await doc.reconcileOnOpen();
    assert.deepEqual(firstLabel, ['Repaired: renumbered 1 variable to match the sentences']);
    assert.deepEqual(relabels, ['Repair on open (interrupted)']);
  });
}

test('a repair that finishes keeps the label naming it', async () => {
  const { doc } = open(() => null);
  const relabels = grouped(doc._client);
  const run = doc._client.batched;
  doc._client.batched = async (fn) => {
    doc._client.operationGroup.written = true;
    return run(fn);
  };
  await doc.reconcileOnOpen();
  assert.deepEqual(relabels, ['Repaired: renumbered 1 variable to match the sentences']);
});

test('a repair that finishes and then fails to re-read keeps the label naming it', async () => {
  const { doc } = open(() => null);
  const relabels = grouped(doc._client);
  const run = doc._client.batched;
  doc._client.batched = async (fn) => {
    doc._client.operationGroup.written = true;
    return run(fn);
  };
  const lost = Object.assign(new Error('Failed to fetch'), { status: 0 });
  doc._reload = async () => {
    throw lost;
  };
  const result = await doc.reconcileOnOpen();
  assert.deepEqual(relabels, ['Repaired: renumbered 1 variable to match the sentences']);
  assert.equal(result.renumbered, 1);
  assert.equal(result.refreshError, lost);
  assert.equal(result.error, undefined);
});
