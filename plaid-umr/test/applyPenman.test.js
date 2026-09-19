// Text mode: a PENMAN text diffed against the stored graph and applied as
// one operation. Against the recording client, then read back through a
// fake reload built from the recorded writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';

const FILE = `################################################################################
# :: snt1	Lindsay left in order to eat lunch .
Index: 1 2 3 4 5 6 7 8
Words: Lindsay left in order to eat lunch .

# sentence level graph:
(s1l / leave-02
    :ARG0 (s1p / person
        :name (s1n / name :op1 "Lindsay"))
    :aspect performance
    :purpose (s1e / eat-01 :ARG0 s1p :aspect performance))

# alignment:
s1l: 2-2
s1p: 1-1
s1n: 0-0
s1e: 6-6

# document level annotation:


`;

const load = () => {
  const plan = planImport(parseUmrFile(FILE).sentences, []);
  const calls = [];
  let n = 0;
  const id = () => `new${++n}`;
  const client = {
    tokens: {
      bulkCreate: async (ops) => {
        calls.push(['tokens.bulkCreate', ops]);
        return { ids: ops.map(() => id()) };
      },
      bulkDelete: async (ids) => calls.push(['tokens.bulkDelete', ids]),
    },
    spans: {
      create: async (layer, tokens, value, metadata) => {
        calls.push(['spans.create', value, metadata]);
        return { id: id() };
      },
      update: async (spanId, value) => calls.push(['spans.update', spanId, value]),
      patchMetadata: async (spanId, patch) => calls.push(['spans.patchMetadata', spanId, patch]),
    },
    relations: {
      create: async (layer, source, target, value, metadata) => {
        calls.push(['relations.create', source, target, value, metadata]);
        return { id: id() };
      },
      delete: async (relId) => calls.push(['relations.delete', relId]),
      patchMetadata: async (relId, patch) => calls.push(['relations.patchMetadata', relId, patch]),
    },
    documents: { get: async () => null },
    withOperation: async (label, fn) => {
      calls.push(['operation', label]);
      return fn(() => {});
    },
  };
  const doc = new UmrDocument({ raw: rawFromPlan(plan), client });
  // The reload after apply is stubbed: the writes are what is checked.
  doc._reload = async () => {};
  doc.onError = (msg) => {
    throw new Error(msg);
  };
  return { doc, calls };
};

test('penmanOf writes the sentence back as PENMAN', () => {
  const { doc } = load();
  const text = doc.penmanOf(1);
  assert.match(text, /^\(s1l \/ leave-02/);
  assert.match(text, /:purpose \(s1e \/ eat-01/);
});

test('planPenman sees no change in the sentence as written', () => {
  const { doc } = load();
  const plan = doc.planPenman(1, doc.penmanOf(1));
  assert.equal(plan.changes, 0);
});

test('planPenman reports a parse error rather than a plan', () => {
  const { doc } = load();
  const plan = doc.planPenman(1, '(s1l / leave-02 :ARG0 (s1p / person');
  assert.ok(plan.errors?.length);
});

test('applyPenman adds a node with its edge, changes a concept and an attribute, drops an edge', async () => {
  const { doc, calls } = load();
  const text = `(s1l / leave-02
    :ARG0 (s1p / person
        :name (s1n / name :op1 "Lindsay"))
    :aspect performance
    :purpose (s1e / eat-01 :ARG0 s1p :ARG1 (s1l2 / lunch) :aspect state))`;
  const plan = doc.planPenman(1, text);
  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].var, 's1l2');
  assert.equal(plan.attrs.length, 1);
  assert.equal(plan.edgesAdd.length, 1);
  assert.equal(plan.edgesDelete.length, 0);
  const changes = await doc.applyPenman(1, text);
  assert.equal(changes, 3);
  const names = calls.map((c) => c[0]);
  assert.deepEqual(names, [
    'operation',
    'tokens.bulkCreate',
    'spans.create',
    'spans.patchMetadata',
    'relations.create',
  ]);
  // The new node is aligned to no word, so it stands over its whole sentence
  // and records it (umrReconcile.js).
  assert.equal(calls[1][1][0].begin, doc.sentence(1).begin);
  assert.equal(calls[1][1][0].end, doc.sentence(1).end);
  assert.equal(calls[2][1], 'lunch');
  assert.equal(calls[4][3], ':ARG1');
  assert.match(calls[0][1], /3 changes/);
});

test('an edge into a deleted node is left to the cascade, not deleted twice', async () => {
  const { doc, calls } = load();
  const text = `(s1e / eat-01 :ARG0 (s1p / person) :aspect performance)`;
  const plan = doc.planPenman(1, text);
  // s1l and s1n go; the :name edge into s1n and the :purpose edge out of s1l
  // go with them, so nothing is deleted by id.
  assert.equal(plan.edgesDelete.length, 0);
  await doc.applyPenman(1, text);
  assert.ok(!calls.some((c) => c[0] === 'relations.delete'));
});

test("a fragment the text never showed is not the text's to delete", async () => {
  const { doc } = load();
  const r = await doc.createNode({ sentenceIndex: 1, concept: 'thing' });
  assert.ok(r);
  const text = doc.penmanOf(1);
  assert.doesNotMatch(text, /thing/);
  assert.equal(doc.planPenman(1, text).changes, 0);
});

test('re-rooting onto a node the text creates clears the old mark first', async () => {
  const { doc, calls } = load();
  const text = `(s1x / say-01
    :ARG1 (s1l / leave-02
        :ARG0 (s1p / person
            :name (s1n / name :op1 "Lindsay"))
        :aspect performance
        :purpose (s1e / eat-01 :ARG0 s1p :aspect performance)))`;
  const plan = doc.planPenman(1, text);
  assert.equal(plan.root, 's1x');
  await doc.applyPenman(1, text);
  const names = calls.map((c) => c[0]);
  const unmark = calls.find((c) => c[0] === 'spans.patchMetadata');
  assert.ok(unmark, 'the old root loses its mark');
  assert.equal(unmark[2].umr.root, undefined);
  assert.ok(names.indexOf('spans.patchMetadata') < names.indexOf('spans.create'));
  const created = calls.find((c) => c[0] === 'spans.create');
  assert.equal(created[2].umr.root, true);
});

test('applyPenman deletes a node the text no longer has and re-roots', async () => {
  const { doc, calls } = load();
  const text = `(s1e / eat-01 :ARG0 (s1p / person) :aspect performance)`;
  const plan = doc.planPenman(1, text);
  assert.deepEqual(plan.delete.length, 2);
  assert.equal(plan.root, 's1e');
  await doc.applyPenman(1, text);
  const names = calls.map((c) => c[0]);
  assert.ok(names.includes('tokens.bulkDelete'));
  const rootPatches = calls.filter((c) => c[0] === 'spans.patchMetadata');
  assert.ok(rootPatches.some((c) => c[2].umr.root === true));
  // The old root was deleted with its subtree, so no mark to clear.
  assert.ok(!rootPatches.some((c) => c[2].umr.root === undefined && c[2].umr.var === 's1l'));
});

// Every metadata patch replaces the umr namespace whole. Built from the state
// read before any write, the old root's attribute change put its root mark
// back (two roots), and the new root's mark reverted its attribute change.
test('moving the root and changing either root attribute keeps both changes', async () => {
  const { doc, calls } = load();
  const text = `(s1e / eat-01
    :ARG0 (s1p / person
        :name (s1n / name :op1 "Lindsay"))
    :aspect activity
    :purpose-of (s1l / leave-02 :ARG0 s1p :aspect state))`;
  await doc.applyPenman(1, text);
  // The last patch of each span is what it ends up as.
  const last = new Map();
  calls
    .filter((c) => c[0] === 'spans.patchMetadata')
    .forEach(([, spanId, patch]) => last.set(spanId, patch.umr));
  const byVar = (v) => [...last.values()].find((m) => m.var === v);
  assert.equal(byVar('s1l').root, undefined);
  assert.deepEqual(
    byVar('s1l').attrs.map((a) => a.value),
    ['state'],
  );
  assert.equal(byVar('s1e').root, true);
  assert.deepEqual(
    byVar('s1e').attrs.map((a) => a.value),
    ['activity'],
  );
});

test('an attribute moved past an edge is stored where it was moved', async () => {
  const { doc } = load();
  const text = doc.penmanOf(1).replace(
    `    :aspect performance
    :purpose`,
    `    :purpose`,
  );
  const moved = text.replace(
    ':aspect performance))',
    ':aspect performance)\n    :aspect performance)',
  );
  const plan = doc.planPenman(1, moved);
  assert.equal(plan.attrs.length, 1);
  assert.deepEqual(
    plan.attrs[0].attrs.map((a) => [a.rel, a.order]),
    [[':aspect', 2]],
  );
});

// What the canvas refuses, text mode refuses: a variable taken or malformed,
// and a new edge that closes a cycle.
test('text mode refuses what the canvas refuses', () => {
  const { doc } = load();
  const base = doc.penmanOf(1);
  const withChild = (child) => base.replace(':ARG0 s1p', `:ARG0 s1p\n        :ARG1 ${child}`);
  assert.match(
    doc.planPenman(1, withChild('(x / thing)')).errors[0].message,
    /x is not a variable/,
  );
  assert.match(
    doc.planPenman(1, withChild('(s1l2 / thing :mod s1l)')).errors[0].message,
    /would close a cycle/,
  );
  assert.equal(doc.planPenman(1, withChild('(s1l2 / thing)')).errors, undefined);
});

// A variable renamed in the text is a new node: the plan says what the old
// one takes with it.
test('the plan names what a deletion takes that the text does not show', () => {
  const { doc } = load();
  const plan = doc.planPenman(1, doc.penmanOf(1).replaceAll('s1l', 's1g'));
  assert.deepEqual(plan.losses, [{ var: 's1l', anchored: true, relations: 0 }]);
});
