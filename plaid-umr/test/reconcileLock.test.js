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

// A document with an anchor no node stands on, as a service's first batch
// leaves one before its second makes the node on it.
function open(lock) {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  const nodes = raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
  nodes.tokens.push({ id: 'fresh-anchor', begin: 0, end: 3 });
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
  assert.equal(result.strays, 1);
  assert.deepEqual(calls.find((c) => c.name === 'tokens.bulkDelete').args[0], ['fresh-anchor']);
});

test('a lock taken after the check is a deferral too, not a failure', async () => {
  const { doc } = open(() => null);
  doc._client.batched = async () => {
    throw Object.assign(new Error('Document is locked by another user'), { status: 423 });
  };
  assert.deepEqual(await doc._reconcile(), { findings: [], deferred: true });
});

// ----- an add under way, seen by someone opening the document -----

// One server both people talk to: the document's layers and its audit log.
function sharedServer() {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  const log = [];
  const nodes = () => raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
  return { raw, log, nodes };
}

// The audit read reconcile makes, answered from the shared log.
const auditFrom =
  (log) =>
  async (_id, { startTime, opTypes }) => ({
    entries: log.filter((e) => e.time >= startTime && opTypes.includes(e.type)),
    nextCursor: null,
  });

test('an open between the requests of an add under way leaves its fresh anchor alone', async () => {
  const server = sharedServer();
  // A adds a node aligned to "Ali". The anchor token lands on the server and
  // in its log, and the node on it is held until B has opened.
  const a = recordingClient();
  let release;
  const held = new Promise((r) => (release = r));
  let anchorMade;
  const anchorLanded = new Promise((r) => (anchorMade = r));
  a.client.tokens.bulkCreate = async (ops) => {
    const ids = ops.map((_, i) => `fresh-${i}`);
    ops.forEach((o, i) => server.nodes().tokens.push({ id: ids[i], begin: o.begin, end: o.end }));
    server.log.push({ type: 'token/bulk-create', time: new Date().toISOString() });
    anchorMade();
    await held;
    return { ids };
  };
  const A = new UmrDocument({ raw: structuredClone(server.raw), client: a.client });
  A._reload = async () => {};
  const adding = A.createNode({
    sentenceIndex: 1,
    concept: 'come-01',
    wordIds: [A.sentence(1).words[0].id],
  });
  await anchorLanded;

  // B opens now: the anchor is there, and no node stands on it yet.
  const b = recordingClient();
  b.client.documents.auditPage = auditFrom(server.log);
  const B = new UmrDocument({ raw: structuredClone(server.raw), client: b.client });
  B._reload = async () => {};
  assert.equal(
    B.layerInfo.nodeTokenLayer.tokens.filter((t) => t.id === 'fresh-0').length,
    1,
    'B sees the bare anchor',
  );
  const result = await B._reconcile();
  assert.deepEqual(result, { findings: [] });
  assert.equal(b.calls.filter((c) => c.name === 'tokens.bulkDelete').length, 0);

  release();
  assert.ok(await adding);
});

test('an anchor an add left long ago is removed on open', async () => {
  const server = sharedServer();
  server.nodes().tokens.push({ id: 'left-over', begin: 0, end: 3 });
  server.log.push({ type: 'token/bulk-create', time: new Date(Date.now() - 3600e3).toISOString() });
  const b = recordingClient();
  b.client.documents.auditPage = auditFrom(server.log);
  const B = new UmrDocument({ raw: structuredClone(server.raw), client: b.client });
  B._reload = async () => {};
  const result = await B._reconcile();
  assert.equal(result.strays, 1);
  assert.deepEqual(b.calls.find((c) => c.name === 'tokens.bulkDelete').args[0], ['left-over']);
});

test('a browser clock minutes fast still leaves an add under way alone', async () => {
  // The server's clock is ten minutes behind this browser's: the anchor made
  // a moment ago is stamped by the server's.
  const serverNow = () => new Date(Date.now() - 10 * 60e3);
  const server = sharedServer();
  server.nodes().tokens.push({ id: 'fresh-0', begin: 0, end: 3 });
  server.log.push({ type: 'token/bulk-create', time: serverNow().toISOString() });
  const b = recordingClient();
  b.client.documents.auditPage = auditFrom(server.log);
  b.client.serverNow = serverNow;
  const B = new UmrDocument({ raw: structuredClone(server.raw), client: b.client });
  B._reload = async () => {};
  assert.deepEqual(await B._reconcile(), { findings: [] });
  assert.equal(b.calls.filter((c) => c.name === 'tokens.bulkDelete').length, 0);
});
