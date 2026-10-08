// Text mode judges a new edge's cycle on the graph the text writes, as the
// canvas's setRole does: an edge relabelled between the same two nodes keeps
// the cycle it stood in and closes none. The case is the opening sentence of
// Kukama text 2 (UMR 2.0), where `s1c :experiencer s1a` closes a loop through
// `s1a :actor-of s1u :purpose s1c` (an inverse role counts as written, as
// validate.py reads it), and relabelling it `:actor` was refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const SEP = '#'.repeat(80);
const TEXT = `${SEP}
# :: snt1
Index: 1 2 3 4 5 6 7 8 9
Words: ikun tɨmɨntsararutsu ikian awa ɨwɨrati rayamiran chikaritara utsun shirinkero

# sentence level graph:
(s1x / ɨmɨntsara
    :actor (s1p / person
        :refer-person 1st
        :refer-number singular)
    :theme (s1a / awa
        :mod (s1i2 / ikian)
        :actor-of (s1u / utsu
            :goal (s1x2 / ɨwɨrati)
            :purpose (s1c / chikari
                :experiencer s1a
                :theme (s1s / shirinkero)
                :aspect state
                :modal-strength full-affirmative
                :quote s1x)
            :aspect performance
            :modal-strength full-affirmative
            :quote s1x)
        :refer-number singular)
    :aspect performance
    :modal-strength full-affirmative
    :temporal (s1i3 / ikun))

# alignment:
s1x: 0-0
s1p: 0-0
s1a: 0-0
s1i2: 3-3
s1u: 8-8
s1x2: 5-5
s1c: 7-7
s1s: 9-9
s1i3: 1-1

# document level annotation:
(s1s0 / sentence)
`;

function load() {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  const { client } = recordingClient();
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  return { doc, errors };
}

test('the experiencer relabelled as actor inside the loop is planned as one swap', () => {
  const { doc } = load();
  const text = doc
    .penmanOf(1)
    .replace(':experiencer s1a', ':actor s1a')
    .replace(':aspect state', ':aspect process');
  const plan = doc.planPenman(1, text);
  assert.equal(plan.errors, undefined);
  assert.deepEqual(
    plan.edgesAdd.map((e) => [e.sourceVar, e.role, e.targetVar]),
    [['s1c', ':actor', 's1a']],
  );
  assert.equal(plan.edgesDelete.length, 1);
  assert.equal(doc.edge(plan.edgesDelete[0]).role, ':experiencer');
});

test('the canvas relabel of the same edge goes through too', async () => {
  const { doc } = load();
  const edge = doc.graph.sentences[0].nodes
    .flatMap((n) => n.out)
    .find((e) => e.role === ':experiencer');
  assert.equal(await doc.setRole(edge.id, ':actor'), true);
});

test('a new cycle beside the relabel is still refused', () => {
  const { doc } = load();
  const text = doc
    .penmanOf(1)
    .replace(':experiencer s1a', ':actor s1a')
    .replace('(s1s / shirinkero)', '(s1s / shirinkero :mod s1u)');
  const { errors } = doc.planPenman(1, text);
  assert.deepEqual(
    errors.map((e) => e.message),
    [':mod from s1s to s1u would close a cycle.'],
  );
});

test('a quote relabelled to a role that closes a cycle is still refused', () => {
  const { doc } = load();
  const text = doc
    .penmanOf(1)
    .replace(
      ':modal-strength full-affirmative\n                :quote s1x',
      ':modal-strength full-affirmative\n                :theme s1x',
    );
  const { errors } = doc.planPenman(1, text);
  assert.deepEqual(
    errors.map((e) => e.message),
    [':theme from s1c to s1x would close a cycle.'],
  );
});

test('one dropped edge relabels one new edge only', () => {
  // The canvas relabels the edge, then refuses a second edge between the
  // same two nodes inside the cycle, as it refuses one beside a kept edge.
  const { doc } = load();
  const text = doc
    .penmanOf(1)
    .replace(':experiencer s1a', ':actor s1a\n                :theme s1a');
  const { errors } = doc.planPenman(1, text);
  assert.deepEqual(
    errors.map((e) => e.message),
    [':theme from s1c to s1a would close a cycle.'],
  );
});

test('a relabel that writes the inverse keeps the pair', async () => {
  const { doc } = load();
  const plan = doc.planPenman(1, doc.penmanOf(1).replace(':experiencer s1a', ':actor-of s1a'));
  assert.equal(plan.errors, undefined);
  assert.deepEqual(
    plan.edgesAdd.map((e) => [e.sourceVar, e.role, e.targetVar]),
    [['s1c', ':actor-of', 's1a']],
  );
  const edge = doc.graph.sentences[0].nodes
    .flatMap((n) => n.out)
    .find((e) => e.role === ':experiencer');
  assert.equal(await doc.setRole(edge.id, ':actor-of'), true);
});
