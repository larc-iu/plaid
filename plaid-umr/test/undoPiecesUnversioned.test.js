// An add whose node request lost its answer after the server stored it: the
// anchors it made are deleted again, and that delete must not claim the
// document version the client held before the lost request, which the server
// has already moved past. Stamped, the delete was refused (409) and the node the
// user was told had failed stayed on the canvas (V4 H4-2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// The node request failed. In the browser the case is a lost answer (status
// 0), which the write queue then waits out for a minute and more, so the test
// fails it with a server error instead: the undo is the same either way.
const nodeRefused = () =>
  Object.assign(new Error('HTTP 500 Internal error'), { status: 500, method: 'POST' });

const load = () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const plan = planImport(parseUmrFile(text).sentences, []);
  const { client, calls } = recordingClient();
  client.strictModeDocumentId = 'doc-1';
  // What strict mode would stamp each delete with: the document the client was
  // in strict mode for when the request was made.
  const stamps = [];
  const bulkDelete = client.tokens.bulkDelete;
  client.tokens.bulkDelete = (ids) => {
    stamps.push(client.strictModeDocumentId);
    return bulkDelete(ids);
  };
  const doc = new UmrDocument({ raw: rawFromPlan(plan), client });
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  // Held as a screen holds it, and let go at the end, so the queue stops
  // retrying the failed add once the test has read what it sent.
  const release = doc.hold();
  return { doc, client, calls, stamps, errors, release };
};

test('a node add that failed after making its anchors deletes them without a version claim', async () => {
  const { doc, client, calls, stamps, release } = load();
  client.spans.create = async () => {
    throw nodeRefused();
  };
  const s1 = doc.sentence(1);
  const result = await doc.createNode({
    sentenceIndex: 1,
    concept: 'die-01',
    wordIds: [s1.words[1].id],
  });
  assert.equal(result, false);
  const deletes = calls.filter((c) => c.name === 'tokens.bulkDelete');
  assert.equal(deletes.length, 1);
  assert.deepEqual(stamps, [null]);
  // Strict mode is back on for every write after it.
  assert.equal(client.strictModeDocumentId, 'doc-1');
  release();
});

test('the anchors already gone is nothing left to undo', async () => {
  const { doc, client, stamps, release } = load();
  client.spans.create = async () => {
    throw nodeRefused();
  };
  client.tokens.bulkDelete = (ids) => {
    stamps.push(client.strictModeDocumentId);
    void ids;
    return Promise.reject(Object.assign(new Error('HTTP 404 Not found'), { status: 404 }));
  };
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args);
  try {
    const s1 = doc.sentence(1);
    await doc.createNode({ sentenceIndex: 1, concept: 'die-01', wordIds: [s1.words[1].id] });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(stamps, [null]);
  assert.equal(
    warned.filter((w) => String(w[0]).includes('Could not remove the anchors')).length,
    0,
  );
  assert.equal(client.strictModeDocumentId, 'doc-1');
  release();
});

// A re-anchor moves a node someone may have made onto the new pieces in the
// batch after them. When that batch's answer is lost after the server stored
// it, the pieces carry that node, and an undo without the version claim
// deleted it, its edges with it (REV-F-REPAIR). Stamped, the delete is refused
// once anything has landed, and the node stays.
test('a re-anchor whose batch failed deletes its new pieces only with the version claim', async () => {
  const { doc, client, stamps, release } = load();
  client.batched = async () => {
    throw nodeRefused();
  };
  const s1 = doc.sentence(1);
  const node = s1.nodes.find((n) => n.wordIds?.length);
  const other = s1.words.find((w) => !node.wordIds.includes(w.id));
  await doc.setAnchor(node.id, [...node.wordIds, other.id]);
  assert.deepEqual(stamps, ['doc-1']);
  assert.equal(client.strictModeDocumentId, 'doc-1');
  release();
});
