// A stored value the .umr file cannot hold as it is refuses the export and is
// listed by sentence and variable (ruled 2026-09-27). Text that is only text
// (the sentence, a metadata line, a gloss item) has its line breaks written
// as spaces instead. Each case here once wrote a file that read back as a
// different graph with no error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUmrFile,
  serializeUmrFile,
  umrFileProblems,
  UnwritableUmrError,
} from '../src/domain/format/umrFile.js';
import { penmanProblems, variableFormProblem } from '../src/domain/format/penman.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { exportProjectUmr } from '../src/domain/umrExport.js';
import { rawFromPlan } from './rawFromPlan.js';

const SEPARATOR = '#'.repeat(80);
const node = (v, concept, children = []) => ({ var: v, concept, children });
const graphOf = (...nodes) => ({
  root: nodes[0].var,
  nodes: new Map(nodes.map((n) => [n.var, n])),
});
const sentence = (over = {}) => ({
  index: 1,
  snt: 1,
  sentenceText: 'the dog',
  meta: [],
  ilg: [],
  words: ['the', 'dog'],
  graph: graphOf(node('s1d', 'dog')),
  alignment: new Map([['s1d', [[2, 2]]]]),
  docGraph: null,
  ...over,
});

const refused = (s) => {
  let error = null;
  try {
    serializeUmrFile({ sentences: [s] });
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof UnwritableUmrError, 'the export was not refused');
  return error.problems;
};

test('a concept, relation or value that would read back as something else is refused', () => {
  const cases = [
    ['concept with a space', graphOf(node('s1d', 'big dog'))],
    ['concept that injects an edge', graphOf(node('s1d', 'dog\n    :ARG0 (s1x / injected)'))],
    ['empty concept', graphOf(node('s1d', ''))],
    [
      'relation that injects a node',
      graphOf(node('s1d', 'dog', [{ rel: ':mod (s1e / evil) :x', kind: 'atom', value: '1' }])),
    ],
    [
      'relation with no colon',
      graphOf(node('s1d', 'dog', [{ rel: 'mod', kind: 'atom', value: '1' }])),
    ],
    [
      'bare value with a bracket',
      graphOf(node('s1d', 'dog', [{ rel: ':quant', kind: 'atom', value: '1) (s1z / evil' }])),
    ],
    [
      'string value with an inner quote',
      graphOf(node('s1d', 'name', [{ rel: ':op1', kind: 'string', value: '"a"b" :op2 x"' }])),
    ],
    [
      'string value with a line break',
      graphOf(
        node('s1d', 'name', [{ rel: ':op1', kind: 'string', value: `"a\n${SEPARATOR}\nb"` }]),
      ),
    ],
    ['variable with a space', graphOf(node('s1 d', 'dog'))],
    ['variable read short', graphOf(node('s1d2x', 'dog'))],
  ];
  for (const [label, graph] of cases) {
    const problems = refused(sentence({ graph }));
    assert.equal(problems.length, 1, label);
    assert.equal(problems[0].sentence, 1, label);
    assert.equal(problems[0].var, [...graph.nodes.keys()][0], label);
  }
});

test('every bad node is listed, not only the first', () => {
  const graph = graphOf(
    node('s1d', 'big dog', [{ rel: ':ARG0', kind: 'node', value: 's1c', inline: true }]),
    node('s1c', 'cat', [{ rel: ':mod', kind: 'atom', value: 'very big' }]),
  );
  const problems = refused(sentence({ graph }));
  assert.deepEqual(
    problems.map((p) => p.var),
    ['s1d', 's1c'],
  );
  assert.match(problems[0].message, /big dog/);
});

test('a graph the file can hold is written, and reads back the same', () => {
  const graph = graphOf(
    node('s1d', 'dog', [
      { rel: ':ARG0-of', kind: 'node', value: 's1b', inline: true },
      { rel: ':name', kind: 'string', value: '"Rex (the dog): a #1"' },
      { rel: ':refer-number', kind: 'atom', value: 'singular' },
    ]),
    node('s1b', 'bark-01'),
  );
  assert.deepEqual(penmanProblems(graph), []);
  const out = serializeUmrFile({ sentences: [sentence({ graph })] });
  const back = parseUmrFile(out);
  assert.deepEqual(back.errors, []);
  assert.equal(back.sentences[0].graph.nodes.get('s1d').children[1].value, '"Rex (the dog): a #1"');
  // Variables of released files that break the convention still write.
  ['x1', 's1x', 'b', 'ṡ1'].forEach((v) => assert.equal(variableFormProblem(v), null, v));
});

test('a line break in text writes as a space and makes no phantom sentence or graph', () => {
  const s = sentence({
    sentenceText: `the dog\n${SEPARATOR}\n# :: snt2\tphantom`,
    meta: ['# ::id x\n# sentence level graph:\n(s1m / meta-injected)'],
    ilg: [
      {
        header: 'Morphemes',
        key: 'morphemes',
        lang: null,
        items: ['DEF', 'dog\n# sentence level graph:\n(s1g / ilg-injected)'],
      },
    ],
  });
  const back = parseUmrFile(serializeUmrFile({ sentences: [s] }));
  assert.equal(back.sentences.length, 1);
  assert.deepEqual([...back.sentences[0].graph.nodes.keys()], ['s1d']);
  assert.match(back.sentences[0].sentenceText, /^the dog #+ # :: snt2\sphantom$/);
});

test('a metadata line that is not a comment, or reads as structure, is refused', () => {
  for (const line of ['not a comment', SEPARATOR, '# sentence level graph:', '# :: snt4']) {
    const problems = refused(sentence({ meta: [line] }));
    assert.equal(problems.length, 1, line);
    assert.equal(problems[0].var, null, line);
  }
});

test('a graph kept as text that holds a block header is refused', () => {
  const problems = refused(
    sentence({ graph: null, rawGraph: '(s1d / dog\n# alignment:\ns1d: 1-1', rawAlignment: '' }),
  );
  assert.equal(problems.length, 1);
});

test('a document-level relation the block cannot hold is refused', () => {
  const docGraph = {
    var: 's1s0',
    temporal: [['s1d', ':before x', 'author']],
    modal: [],
    coref: [],
  };
  const problems = refused(sentence({ docGraph }));
  assert.equal(problems.length, 1);
});

// Through the document model, as the Export tab and the project export read it.
const FILE = `${SEPARATOR}
# :: snt1\tthe dog
Index: 1 2
Words: the dog

# sentence level graph:
(s1d / dog
    :mod (s1b / big))

# alignment:
s1d: 2-2
s1b: 0-0

# document level annotation:

`;
const loadWith = (concept) => {
  const raw = rawFromPlan(planImport(parseUmrFile(FILE).sentences, []));
  const concepts = raw.textLayers[0].tokenLayers[2].spanLayers[0];
  concepts.spans.find((x) => x.metadata.umr.var === 's1b').value = concept;
  return { raw, doc: new UmrDocument({ raw }) };
};

test('the document lists what the API stored, and its export refuses', () => {
  const { doc } = loadWith('very big');
  assert.deepEqual(
    doc.exportProblems.map((p) => [p.sentence, p.var]),
    [[1, 's1b']],
  );
  assert.throws(() => doc.toUmr(), UnwritableUmrError);
  assert.deepEqual(loadWith('big').doc.exportProblems, []);
  assert.match(loadWith('big').doc.toUmr(), /:mod \(s1b \/ big\)/);
});

test('the project export names every document with a problem, and writes none', async () => {
  const good = loadWith('big').raw;
  const bad = loadWith('big dog').raw;
  const client = {
    projects: {
      listDocuments: async () => [
        { id: 'a', name: 'Good' },
        { id: 'b', name: 'Lunch' },
      ],
    },
    documents: { get: async (id) => (id === 'a' ? good : bad) },
  };
  await assert.rejects(exportProjectUmr(client, 'p'), (e) => {
    assert.ok(e instanceof UnwritableUmrError);
    assert.deepEqual(
      e.problems.map((p) => [p.document, p.sentence, p.var]),
      [['Lunch', 1, 's1b']],
    );
    assert.match(e.message, /^Lunch, sentence 1, s1b: /);
    return true;
  });
  assert.deepEqual(umrFileProblems([]), []);
});
