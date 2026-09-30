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

// A document one of whose words has no syntactic word, as a word made in
// another app leaves it. The operation's label is the one it opened with, or
// the last message the pass set.
function bare(get) {
  const raw = rawDocFromConllu(INPUT, 'e');
  const syntactic = raw.textLayers[0].tokenLayers[2];
  const left = syntactic.tokens.find(
    (t) => raw.textLayers[0].text.body.slice(t.begin, t.end) === 'left',
  );
  syntactic.tokens = syntactic.tokens.filter((t) => t !== left);
  for (const sl of syntactic.spanLayers) {
    sl.spans = (sl.spans || []).filter((sp) => !sp.tokens.includes(left.id));
    for (const rl of sl.relationLayers || []) {
      const gone = new Set((sl.spans || []).map((sp) => sp.id));
      rl.relations = (rl.relations || []).filter((r) => gone.has(r.source) && gone.has(r.target));
    }
  }
  const created = [];
  const client = withOps({
    tokens: { bulkCreate: async (rows) => created.push(...rows) },
    relations: { delete: async () => {} },
    documents: { get },
    tokenLayers: { setConfig: async () => {} },
  });
  const labels = [];
  client.withOperation = async (message, fn) => {
    labels.push(message);
    return fn((m) => labels.push(m));
  };
  return { doc: new ConlluDocument({ raw, client }), created, labels };
}

test('a repair that lands and then fails to re-read keeps the label naming it', async () => {
  const lost = Object.assign(new Error('Failed to fetch'), { status: 0 });
  const { doc, created, labels } = bare(async () => {
    throw lost;
  });
  const result = await doc.reconcileOnOpen();
  assert.equal(created.length, 1);
  assert.equal(result.createdSyntacticWords, 1);
  assert.equal(result.refreshError, lost);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(labels, ['Repair on open', 'Repaired: added 1 word to the annotation grid']);
});

test('a repair whose write fails is still labeled as interrupted', async () => {
  const { doc, labels } = bare(async () => {
    throw new Error('not reached');
  });
  doc._client.tokens.bulkCreate = async () => {
    throw Object.assign(new Error('refused'), { status: 500 });
  };
  const result = await doc.reconcileOnOpen();
  assert.ok(result.error);
  assert.equal(result.refreshError, undefined);
  assert.deepEqual(labels, ['Repair on open', 'Repair on open (interrupted)']);
});
