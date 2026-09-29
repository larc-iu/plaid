// Reconcile on open, when every repair write lands and the refetch after them
// fails: the repair is whole, so History names it, and the screen is what is
// out of date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

// The pass logs its failures, which are the point here.
console.error = () => {};

const INPUT = [
  '# text = she came',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t_\t_',
  '2\tcame\tcome\tVERB\t_\t_\t0\troot\t_\t_',
  '',
  '# text = he left',
  '1\the\the\tPRON\t_\t_\t2\tnsubj\t_\t_',
  '2\tleft\tleave\tVERB\t_\t_\t0\troot\t_\t_',
].join('\n');

// A document with one relation from "came" to "left", across the sentence
// boundary, as a split in another app leaves one. The operation's label is
// the one it opened with, or the last message the pass set.
function crossing(get) {
  const raw = rawDocFromConllu(INPUT, 'e');
  const layer = raw.textLayers[0].tokenLayers[2].spanLayers[1].relationLayers[0];
  const lemmas = raw.textLayers[0].tokenLayers[2].spanLayers[1].spans;
  const id = (v) => lemmas.find((s) => s.value === v).id;
  layer.relations.push({ id: 'across', source: id('come'), target: id('leave'), value: 'conj' });
  const deleted = [];
  const client = withOps({
    relations: { delete: async (rid) => deleted.push(rid) },
    documents: { get },
    tokenLayers: { setConfig: async () => {} },
  });
  const labels = [];
  client.withOperation = async (message, fn) => {
    labels.push(message);
    return fn((m) => labels.push(m));
  };
  return { doc: new ConlluDocument({ raw, client }), deleted, labels };
}

test('a repair that lands and then fails to re-read keeps the label naming it', async () => {
  const lost = Object.assign(new Error('Failed to fetch'), { status: 0 });
  const { doc, deleted, labels } = crossing(async () => {
    throw lost;
  });
  const result = await doc.reconcileOnOpen();
  assert.deepEqual(deleted, ['across']);
  assert.equal(result.deletedRelations, 1);
  assert.equal(result.refreshError, lost);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(labels, [
    'Repair on open',
    'Repaired: removed 1 relation crossing a sentence boundary',
  ]);
});

test('a repair whose write fails is still labeled as interrupted', async () => {
  const { doc, labels } = crossing(async () => {
    throw new Error('not reached');
  });
  doc._client.relations.delete = async () => {
    throw Object.assign(new Error('refused'), { status: 500 });
  };
  const result = await doc.reconcileOnOpen();
  assert.ok(result.error);
  assert.equal(result.refreshError, undefined);
  assert.deepEqual(labels, ['Repair on open', 'Repair on open (interrupted)']);
});
