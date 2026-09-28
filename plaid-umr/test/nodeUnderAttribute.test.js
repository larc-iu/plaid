// A new node under a relation that takes a value (a list item, an attribute
// with a closed set of values, :ARG2 of have-polarity-91) is refused where it
// is written, with the words the assistant and the draft service use, rather
// than reported by Validation after. One an import brought is only reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { KNOWN_RELATIONS } from '../src/domain/format/inventory.js';
import { nodeUnderAttributeProblem, validateSentence } from '../src/domain/format/validate.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'umr',
  'english_umr-0001.umr',
);

const load = () => {
  const plan = planImport(parseUmrFile(fs.readFileSync(FIXTURE, 'utf8')).sentences, []);
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({ raw: rawFromPlan(plan), client });
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  return { doc, calls, errors };
};

const byVar = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);

test('the relations that take a value only', () => {
  assert.equal(nodeUnderAttributeProblem(':aspect'), "':aspect' takes a value, not a node.");
  assert.equal(nodeUnderAttributeProblem('li'), "':li' takes a value, not a node.");
  assert.ok(nodeUnderAttributeProblem(':list-item'));
  assert.ok(nodeUnderAttributeProblem(':refer-number'));
  assert.ok(nodeUnderAttributeProblem(':ARG2', 'have-polarity-91'));
  // A value or a node: :mod, :polarity, :quant, :op1, an argument.
  for (const rel of [':mod', ':polarity', ':quant', ':op1', ':op3', ':ARG2', ':ARG0']) {
    assert.equal(nodeUnderAttributeProblem(rel, 'eat-01'), null, rel);
  }
  assert.equal(nodeUnderAttributeProblem(':ARG2', 'have-quant-91'), null);
});

test('it refuses exactly what Validation reports of a node in that place', () => {
  const cases = [
    ...Object.keys(KNOWN_RELATIONS).map((rel) => [rel, 'thing']),
    [':ARG2', 'have-polarity-91'],
    [':ARG2', 'have-quant-91'],
    [':ARG1', 'rate-entity-91'],
    [':op2', 'thing'],
    [':op1', 'name'],
    [':op2', 'name'],
    [':mod', 'name'],
  ];
  for (const [rel, concept] of cases) {
    const text = `(s1x / ${concept}\n    ${rel} (s1y / thing))`;
    const [sentence] = parseUmrFile(
      `${'#'.repeat(80)}\n# :: snt1\nIndex: 1 2\nWords: a b\n\n# sentence level graph:\n${text}\n\n# alignment:\ns1x: 1-1\ns1y: 2-2\n\n# document level annotation:\n(s1s0 / sentence)\n\n\n`,
    ).sentences;
    const reported = validateSentence(sentence).some(
      (f) => f.code === 'unexpected-value' && f.var === 's1x',
    );
    assert.equal(Boolean(nodeUnderAttributeProblem(rel, concept)), reported, `${concept} ${rel}`);
  }
});

test('Text mode refuses a new node under an attribute', async () => {
  const { doc, errors } = load();
  const text = doc.penmanOf(1).replace(':aspect state)', ':aspect (s1z / state))');
  assert.notEqual(text, doc.penmanOf(1), 'fixture');
  assert.equal(await doc.applyPenman(1, text), false);
  assert.deepEqual(errors, ["s1d: ':aspect' takes a value, not a node."]);
});

test('the canvas refuses a new node, an edge and a relabel under an attribute', async () => {
  const { doc, calls, errors } = load();
  const die = byVar(doc, 's1d');
  const fear = byVar(doc, 's1f');
  assert.equal(
    await doc.createNode({ sentenceIndex: 1, concept: 'x', parentId: die.id, role: ':li' }),
    false,
  );
  assert.equal(await doc.createEdge(die.id, byVar(doc, 's1c').id, ':refer-number'), false);
  const edge = fear.in[0];
  assert.equal(await doc.setRole(edge.id, ':aspect'), false);
  assert.deepEqual(errors, [
    "':li' takes a value, not a node.",
    "':refer-number' takes a value, not a node.",
    "':aspect' takes a value, not a node.",
  ]);
  assert.deepEqual(
    calls.filter((c) => c.name !== 'operation'),
    [],
  );
});

test('Text mode keeps a node an import brought under an attribute', async () => {
  const source = fs
    .readFileSync(FIXTURE, 'utf8')
    .replace(':aspect state)\n            :op2', ':aspect (s1z / state))\n            :op2');
  const plan = planImport(parseUmrFile(source).sentences, []);
  const { client } = recordingClient();
  const doc = new UmrDocument({ raw: rawFromPlan(plan), client });
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  assert.ok(byVar(doc, 's1z'), 'fixture');
  const text = doc.penmanOf(1).replace('override-91', 'override-92');
  assert.ok(await doc.applyPenman(1, text));
  assert.deepEqual(errors, []);
  // Moved to another parent, it keeps moving as it came.
  const edge = byVar(doc, 's1z').in[0];
  assert.ok(await doc.moveEdge(edge.id, byVar(doc, 's1f').id));
  assert.deepEqual(errors, []);
});

// A concept is a write too: giving a node the concept that makes a relation
// it already has value-only (a name's :opN, :ARG2 of have-polarity-91) puts
// a node there as surely as a new edge does.
test('the canvas refuses a concept that puts a node it points at under a value-only relation', async () => {
  const { doc, calls, errors } = load();
  const and = byVar(doc, 's1a');
  assert.equal(await doc.setConcept(and.id, 'name'), false);
  assert.deepEqual(errors, ["':op1' takes a value, not a node."]);
  assert.equal(await doc.setConcept(byVar(doc, 's1l').id, 'have-polarity-91'), true);
  assert.equal(
    calls.filter((c) => c.name !== 'operation').length > 0,
    true,
    'a concept that leaves every edge where it may stand is written',
  );
});

test('Text mode refuses a concept that puts a node it points at under a value-only relation', async () => {
  const { doc, errors } = load();
  const text = doc.penmanOf(1).replace('(s1a / and', '(s1a / name');
  assert.notEqual(text, doc.penmanOf(1), 'fixture');
  assert.equal(await doc.applyPenman(1, text), false);
  assert.deepEqual(errors, ["s1a: ':op1' takes a value, not a node."]);
});

test('a name an import brought with a node under :op1 keeps it through a concept edit elsewhere', async () => {
  const source = fs
    .readFileSync(FIXTURE, 'utf8')
    .replace('(s1n / name :op1 "Philippines")', '(s1n / name :op1 (s1z / thing))');
  const plan = planImport(parseUmrFile(source).sentences, []);
  const { client } = recordingClient();
  const doc = new UmrDocument({ raw: rawFromPlan(plan), client });
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  assert.ok(byVar(doc, 's1z'), 'fixture');
  const text = doc.penmanOf(1).replace('override-91', 'override-92');
  assert.ok(await doc.applyPenman(1, text));
  assert.deepEqual(errors, []);
});
