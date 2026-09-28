// `:li` takes a number, as in AMR: the item's place in a list, -1 for the
// last (decided 2026-09-28). It is typed as an attribute, so a number under
// it is not "a value where a node belongs", and anything but a whole number
// is refused on new input and reported by Validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_RELATIONS, INTEGER_ATTRIBUTES } from '../src/domain/format/inventory.js';
import { parseUmrFile, serializeUmrFile } from '../src/domain/format/umrFile.js';
import {
  validateSentence,
  valueGrammarProblem,
  unknownRelationProblem,
} from '../src/domain/format/validate.js';
import { readAttrLine } from '../src/components/editor/annotation/pickers.js';
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

test('the inventory types :li as an attribute that takes a whole number', () => {
  assert.equal(KNOWN_RELATIONS[':li'].type, 'attribute');
  assert.equal(KNOWN_RELATIONS[':li'].repeat, false);
  assert.deepEqual(INTEGER_ATTRIBUTES, [':li']);
});

test('Validation takes a number under :li, -1 for the last item', () => {
  assert.deepEqual(findings(LIST('3')), []);
  assert.deepEqual(findings(LIST('-1')), []);
});

test('Validation reports anything under :li but a whole number', () => {
  for (const [value, kind] of [
    ['c', 'c'],
    ['"(c)"', '(c)'],
    ['1.5', '1.5'],
  ]) {
    const found = findings(LIST(value));
    assert.equal(found.length, 1, value);
    assert.equal(found[0].var, 's1o');
    assert.equal(
      found[0].message,
      `The value '${kind}' of ':li' is not a whole number. ':li' takes the item's place in the list, -1 for the last.`,
    );
  }
  const node = findings(LIST('(s1x / thing)'));
  assert.deepEqual(
    node.map((f) => [f.var, f.message]),
    [
      [
        's1o',
        "':li' takes a whole number, the item's place in the list, -1 for the last. Found the node 's1x'.",
      ],
    ],
  );
});

test('the check the editors refuse new values with holds :li to a number', () => {
  assert.equal(valueGrammarProblem('2', ':li'), null);
  assert.equal(valueGrammarProblem('-1', ':li'), null);
  assert.equal(valueGrammarProblem('b', ':li').code, 'unexpected-value');
  assert.equal(valueGrammarProblem('"(b)"', ':li').code, 'unexpected-value');
  // Any other attribute is as before.
  assert.equal(valueGrammarProblem('b', ':mod'), null);
  assert.equal(valueGrammarProblem('b'), null);
});

test('the attribute line takes :li 2 and refuses :li b', () => {
  assert.equal(readAttrLine(':li 2', unknownRelationProblem).problem, null);
  assert.deepEqual(readAttrLine(':li -1', unknownRelationProblem).attrs, [
    { rel: ':li', value: '-1' },
  ]);
  assert.match(readAttrLine(':li b', unknownRelationProblem).problem, /not a whole number/);
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

test('Text mode and the attribute editor take a number under :li and refuse a word', async () => {
  const { doc, errors } = load();
  assert.equal(doc.planPenman(1, LIST('3')).errors, undefined);
  const plan = doc.planPenman(1, LIST('c'));
  assert.ok(plan.errors?.length);
  assert.match(plan.errors[0].message, /not a whole number/);
  const onion = [...doc.graph.nodesById.values()].find((n) => n.var === 's1o');
  assert.equal(await doc.setAttrs(onion.id, [{ rel: ':li', value: 'last' }]), false);
  assert.match(errors.at(-1), /not a whole number/);
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
