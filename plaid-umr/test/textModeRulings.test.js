// Text mode and the editors after the owner's rulings of 2026-09-28: every
// concept change is named before Apply, an empty text deletes the graph, a
// new value validate.py cannot read is refused while an imported one is
// kept, and Discard graph keeps a drafted edge into a node a person
// corrected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROV, provState, PROV_STATES } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const SEP = '#'.repeat(80);
const TEXT = `${SEP}
# :: snt1
Index: 1 2 3
Words: the cat sleeps

# sentence level graph:
(s1y / sleep-01
    :ARG0 (s1x / cat)
    :mode Imperative)

# alignment:
s1y: 3-3
s1x: 2-2

# document level annotation:
(s1s0 / sentence
    :temporal ((document-creation-time :overlap s1y))
    :modal ((root :modal author)
        (author :full-affirmative s1y)))

${SEP}
# :: snt2
Index: 1 2 3
Words: goat eats grass

# sentence level graph:
(s2e / eat-01
    :ARG0 (s2g / goat
        :color (s2w / white)))

# alignment:
s2e: 2-2
s2g: 1-1
s2w: 0-0

# document level annotation:
(s2s0 / sentence)
`;

const load = ({ drafted = false } = {}) => {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  if (drafted) {
    const concepts = raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes).spanLayers[0];
    const draft = { [PROV.key]: PROV.INFERRED, [PROV.sourceKey]: 'service:umr-draft-llm' };
    concepts.spans.forEach((s) => (s.metadata = { ...draft, ...s.metadata }));
    concepts.relationLayers.forEach((l) =>
      (l.relations || []).forEach((r) => (r.metadata = { ...draft, ...r.metadata })),
    );
  }
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({ raw, client, user: drafted ? { id: 'v@x.com' } : null });
  doc._reload = async () => {};
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  return { doc, calls, errors };
};

const byVar = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);

test('two variable names exchanged in the text are named as the concept changes they are', () => {
  const { doc } = load();
  const plan = doc.planPenman(1, '(s1x / sleep-01\n    :ARG0 (s1y / cat))');
  assert.deepEqual(plan.concept.map((c) => [c.var, c.from, c.concept]).sort(), [
    ['s1x', 'cat', 'sleep-01'],
    ['s1y', 'sleep-01', 'cat'],
  ]);
  assert.deepEqual(plan.rename, []);
});

test('an empty text plans the deletion of every node, with what goes', async () => {
  const { doc, calls } = load();
  const plan = doc.planPenman(1, '  \n');
  assert.equal(plan.errors, undefined);
  assert.deepEqual(plan.delete.sort(), [byVar(doc, 's1x').id, byVar(doc, 's1y').id].sort());
  assert.deepEqual(plan.losses.map((l) => [l.var, l.anchored, l.relations]).sort(), [
    ['s1x', true, 0],
    ['s1y', true, 2],
  ]);
  assert.equal(await doc.applyPenman(1, ''), 2);
  assert.equal(doc.sentence(1).nodes.length, 0);
  assert.ok(calls.some((c) => c.name === 'tokens.bulkDelete'));
  // Text that is not empty and holds no graph is still a mistake.
  assert.deepEqual(doc.planPenman(2, 'goat').errors?.length > 0, true);
});

test('a new value validate.py cannot read is refused with the reason, an imported one is kept', async () => {
  const { doc, errors } = load();
  // Imported `:mode Imperative` goes back unchanged.
  const kept = doc.planPenman(
    1,
    '(s1y / sleep-01\n    :ARG0 (s1x / cat\n        :mod big)\n    :mode Imperative)',
  );
  assert.equal(kept.errors, undefined);
  // The same value new on another node is refused, and so are the others
  // validate.py cannot read.
  for (const [value, why] of [
    ['Imperative', /capital letter/],
    ['.5', /not a number/],
    ['""', /empty/],
    ['"O\\"Brien"', /quote/],
    ['café', /not a number or a word/],
  ]) {
    const plan = doc.planPenman(
      1,
      `(s1y / sleep-01\n    :ARG0 (s1x / cat\n        :mod ${value})\n    :mode Imperative)`,
    );
    assert.ok(plan.errors?.length, `${value} refused`);
    assert.match(plan.errors[0].message, why, value);
  }
  // The attribute editor refuses the same, and keeps the node's own.
  assert.equal(await doc.setAttrs(byVar(doc, 's1x').id, [{ rel: ':mod', value: 'Big' }]), false);
  assert.match(errors.at(-1), /capital letter/);
  assert.notEqual(
    await doc.setAttrs(byVar(doc, 's1y').id, [
      { rel: ':mode', value: 'Imperative' },
      { rel: ':polarity', value: '-' },
    ]),
    false,
  );
});

test('Discard graph keeps a drafted edge into a node a person corrected, still drafted', async () => {
  const { doc } = load({ drafted: true });
  const goat = byVar(doc, 's2g');
  assert.equal(await doc.confirmNode(goat.id), true);
  assert.equal(await doc.setConcept(byVar(doc, 's2w').id, 'black'), true);
  const plan = doc.discardPlan(2);
  // eat-01 is drafted, but the accepted :ARG0 into goat needs it.
  assert.deepEqual(plan.nodes, []);
  assert.deepEqual(plan.relations, []);
  assert.equal(doc.canDiscardSentence(2), false);
  const color = byVar(doc, 's2g').out.find((e) => e.role === ':color');
  assert.ok(color);
  assert.equal(provState(color.metadata), PROV_STATES.MACHINE);
});
