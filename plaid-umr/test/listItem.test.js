// `:li` takes the item's place in a list as a whole number, as in AMR (-1
// for the last), or its label as a quoted string, as the UMR guidelines'
// own example writes it (`:li "(a)"`, 3-2-2-6 (1c)). Decided 2026-09-28. It
// is typed as an attribute, so a value under it is not "a value where a node
// belongs", and anything else is refused on new input and reported by
// Validation. `:list-item` is the same relation under the schema's name
// (roles_and_reifications.json, `:list-item "1"`) and is held to the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_RELATIONS, LIST_ITEM_ATTRIBUTES, ROLES } from '../src/domain/format/inventory.js';
import { parseUmrFile, serializeUmrFile } from '../src/domain/format/umrFile.js';
import {
  validateSentence,
  valueGrammarProblem,
  unknownRelationProblem,
} from '../src/domain/format/validate.js';
import { readAttrLine, roleOptions } from '../src/components/editor/annotation/pickers.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const SEP = '#'.repeat(80);
const file = (graph) =>
  [
    SEP,
    '# :: snt1',
    'Index: 1 2 3',
    'Words: rice beans onions',
    '',
    '# sentence level graph:',
    graph,
    '',
    '# alignment:',
    's1a: 0-0',
    's1r: 1-1',
    's1b: 2-2',
    's1o: 3-3',
    '',
    '# document level annotation:',
    '(s1s0 / sentence)',
    '',
    '',
    '',
  ].join('\n');
const LIST = (third) =>
  `(s1a / and\n    :op1 (s1r / rice\n        :li 1)\n    :op2 (s1b / bean\n        :li 2)\n    :op3 (s1o / onion\n        :li ${third}))`;

const findings = (graph) =>
  validateSentence(parseUmrFile(file(graph)).sentences[0], {
    checkCompleteAlignment: false,
    checkUnalignedToken: false,
    requireDocumentLevel: false,
  }).filter((f) => f.code === 'unexpected-value');

const WHY = `':li' takes the item's place in the list (-1 for the last) or its label in quotes, such as "(a)".`;

test('the inventory types :li and :list-item as attributes, never offered as roles', () => {
  for (const rel of [':li', ':list-item']) {
    assert.equal(KNOWN_RELATIONS[rel].type, 'attribute');
    assert.equal(KNOWN_RELATIONS[rel].repeat, false);
  }
  assert.deepEqual(LIST_ITEM_ATTRIBUTES, [':li', ':list-item']);
  assert.ok(!Object.values(ROLES).flat().includes(':list-item'));
  assert.ok(!Object.values(ROLES).flat().includes(':li'));
});

test('the role picker does not offer :list-item', () => {
  const offered = roleOptions(null).flatMap((g) => g.items.map((i) => i.value ?? i));
  assert.ok(offered.includes(':ord'));
  assert.ok(!offered.includes(':list-item'));
});

test("Validation takes a number under :li, -1 for the last item, and the guidelines' quoted label", () => {
  assert.deepEqual(findings(LIST('3')), []);
  assert.deepEqual(findings(LIST('-1')), []);
  assert.deepEqual(findings(LIST('"(c)"')), []);
  assert.deepEqual(findings(LIST('"3"').replace(/:li\b/g, ':list-item')), []);
});

test('Validation reports anything else under :li or :list-item', () => {
  for (const [value, kind] of [
    ['c', 'c'],
    ['1.5', '1.5'],
    ['last', 'last'],
  ]) {
    const found = findings(LIST(value));
    assert.equal(found.length, 1, value);
    assert.equal(found[0].var, 's1o');
    assert.equal(
      found[0].message,
      `The value '${kind}' of ':li' is neither a number nor a quoted label. ${WHY}`,
    );
  }
  const node = findings(LIST('(s1x / thing)'));
  assert.deepEqual(
    node.map((f) => [f.var, f.message]),
    [['s1o', `${WHY} Found the node 's1x'.`]],
  );
});

test('the check the editors refuse new values with holds :li to a number or a quoted label', () => {
  assert.equal(valueGrammarProblem('2', ':li'), null);
  assert.equal(valueGrammarProblem('-1', ':li'), null);
  assert.equal(valueGrammarProblem('b', ':li').code, 'unexpected-value');
  assert.equal(valueGrammarProblem('"(b)"', ':li'), null);
  assert.equal(valueGrammarProblem('"1"', ':list-item'), null);
  assert.equal(valueGrammarProblem('first', ':list-item').code, 'unexpected-value');
  assert.equal(valueGrammarProblem('1.5', ':li').code, 'unexpected-value');
  // Any other attribute is as before.
  assert.equal(valueGrammarProblem('b', ':mod'), null);
  assert.equal(valueGrammarProblem('b'), null);
});

test('the attribute line takes :li 2 and :li "(b)", and refuses :li b', () => {
  assert.equal(readAttrLine(':li 2', unknownRelationProblem).problem, null);
  assert.equal(readAttrLine(':li "(b)"', unknownRelationProblem).problem, null);
  assert.deepEqual(readAttrLine(':li -1', unknownRelationProblem).attrs, [
    { rel: ':li', value: '-1' },
  ]);
  assert.match(
    readAttrLine(':li b', unknownRelationProblem).problem,
    /neither a number nor a quoted label/,
  );
});

const load = () => {
  const raw = rawFromPlan(planImport(parseUmrFile(file(LIST('-1'))).sentences, []));
  const { client } = recordingClient();
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  return { doc, errors };
};

test('Text mode and the attribute editor take a number or a quoted label under :li and refuse a word', async () => {
  const { doc, errors } = load();
  assert.equal(doc.planPenman(1, LIST('3')).errors, undefined);
  assert.equal(doc.planPenman(1, LIST('"(c)"')).errors, undefined);
  const plan = doc.planPenman(1, LIST('c'));
  assert.ok(plan.errors?.length);
  assert.match(plan.errors[0].message, /neither a number nor a quoted label/);
  const onion = [...doc.graph.nodesById.values()].find((n) => n.var === 's1o');
  assert.equal(await doc.setAttrs(onion.id, [{ rel: ':li', value: 'last' }]), false);
  assert.match(errors.at(-1), /neither a number nor a quoted label/);
});

test('a document with :li round-trips through import and export, and Validation is clean', () => {
  const { doc } = load();
  const written = doc.toUmr();
  const again = parseUmrFile(written).sentences[0];
  const values = [...again.graph.nodes.values()].flatMap((n) =>
    n.children.filter((c) => c.rel === ':li').map((c) => [n.var, c.kind, c.value]),
  );
  assert.deepEqual(values, [
    ['s1r', 'atom', '1'],
    ['s1b', 'atom', '2'],
    ['s1o', 'atom', '-1'],
  ]);
  assert.equal(serializeUmrFile(parseUmrFile(written)), written);
  assert.deepEqual(
    doc.problems.filter((p) => p.code === 'unexpected-value'),
    [],
  );
});
