// A document imported from a file that numbers its own sentences (an excerpt
// starting at snt5) goes by the file's numbers everywhere: the number its
// sentence shows, the variables a new node is given and the one a typed name
// must carry, the document block the export names, and the import's report
// (H9-NUM-2 and H9-NUM-5). It used to show 1 over `s5…` variables, mint
// `s1z`, refuse `s5z`, and export `(s1s0 / sentence` under `# :: snt5`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport, readerNotes } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { nodeOptions } from '../src/components/editor/annotation/pickers.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';
import { validateProject } from '../src/domain/validationQueries.js';
import { planRenumber } from '../src/domain/umrReconcile.js';
import { insertSentenceAtStart } from './igtInsertSentence.js';

const SEP = '#'.repeat(80);
const block = (n, extra = '') => `${SEP}
# :: snt${n}
Index: 1 2
Words: dogs bark

# sentence level graph:
(s${n}b / bark-01
    :actor (s${n}d / dog))

# alignment:
s${n}b: 2-2
s${n}d: 1-1

# document level annotation:
(s${n}s0 / sentence
    :temporal ((document-creation-time :before s${n}b))${extra})
`;

// snt6's block names a node of snt5 that the file never defines.
const EXCERPT = `${block(5)}\n${block(6, '\n    :coref ((s4x :same-entity s6d))')}`;

function load(text = EXCERPT) {
  const raw = rawFromPlan(planImport(parseUmrFile(text).sentences, []));
  const { client } = recordingClient();
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  return { doc, errors };
}

test('the sentences go by the numbers the file gives them', () => {
  const { doc } = load();
  assert.deepEqual(
    doc.graph.sentences.map((s) => [s.index, s.number]),
    [
      [1, 5],
      [2, 6],
    ],
  );
  assert.deepEqual(
    nodeOptions(doc.graph).map((g) => g.group),
    ['Sentence 5', 'Sentence 6'],
  );
});

test('a document numbered from 1 goes by its places as before', () => {
  const { doc } = load(`${block(1)}\n${block(2)}`);
  assert.deepEqual(
    doc.graph.sentences.map((s) => s.number),
    [1, 2],
  );
});

test("a new node is named for the file's number", async () => {
  const { doc, errors } = load();
  const made = await doc.createNode({ sentenceIndex: 1, concept: 'zebra' });
  assert.ok(made, errors.join('; '));
  assert.ok(
    doc.graph.sentences[0].nodes.some((n) => n.var === 's5z'),
    doc.graph.sentences[0].nodes.map((n) => n.var).join(' '),
  );
});

test("a typed name carries the file's number, and the place is refused", () => {
  const { doc } = load();
  const add = (v) => doc.penmanOf(1).replace('(s5d / dog)', `(s5d / dog :mod (${v} / zebra))`);
  assert.equal(doc.planPenman(1, add('s5z')).errors, undefined);
  assert.deepEqual(
    doc.planPenman(1, add('s1z')).errors.map((e) => e.message),
    ['s1z names sentence 1, and the node is in sentence 5.'],
  );
});

test("the export keeps the file's document blocks and numbers", () => {
  const { doc } = load();
  const out = doc.toUmr();
  assert.match(out, /# :: snt5\n/);
  assert.match(out, /\(s5s0 \/ sentence/);
  assert.match(out, /\(s6s0 \/ sentence/);
  assert.doesNotMatch(out, /\(s[12]s0 \//);
});

test("the import's report names a sentence by the file's number", () => {
  const warnings = [];
  planImport(parseUmrFile(EXCERPT).sentences, warnings);
  assert.ok(
    warnings.some((w) => w.startsWith('Sentence 6: (s4x :same-entity s6d) dropped')),
    warnings.join('\n'),
  );
  assert.ok(!warnings.some((w) => /^Sentence [12]:/.test(w)), warnings.join('\n'));
  // The reader's own notes too: a sentence with no `# :: snt` line.
  const parsed = parseUmrFile(
    EXCERPT.replace('Words: dogs bark\n', 'Words: dogs bark\n# :: odd\n'),
  );
  assert.ok(readerNotes(parsed).every((line) => !/^Sentence [12]:/.test(line)));
});

// History, the Validation tab and the canvas's own problems name a sentence
// as its header does. They named its place: "Apply text to sentence 1" for
// the sentence shown as 5.
test("History and the Validation tab name a sentence by the file's number", async () => {
  const { doc, errors } = load();
  const { client, calls } = recordingClient();
  doc._client = client;
  const labels = () => calls.filter((c) => c.name === 'operation').map((c) => c.args[0]);
  const text = doc.penmanOf(2).replace('(s6d / dog)', '(s6d / dog :mod (s6z / zebra))');
  assert.ok(await doc.applyPenman(2, text), errors.join('; '));
  // What Accept names its operation, whatever the nodes' provenance.
  let accepted = null;
  doc._confirm = async (_nodes, _error, label) => {
    accepted = label;
    return true;
  };
  await doc.confirmSentence(2);
  assert.ok(
    labels().some((l) => l.startsWith('Apply text to sentence 6 (')),
    labels().join(' | '),
  );
  assert.equal(accepted, 'Accept the graph of sentence 6');

  // A word no node is aligned to, in each sentence, for a row each.
  const loud = EXCERPT.replaceAll(
    'Index: 1 2\nWords: dogs bark',
    'Index: 1 2 3\nWords: dogs bark loudly',
  );
  const raw = rawFromPlan(planImport(parseUmrFile(loud).sentences, []));
  const rows = await validateProject(
    {
      projects: { listDocuments: async () => [{ id: 'd1', name: 'Excerpt' }] },
      documents: { get: async () => raw },
    },
    'p1',
  );
  const placed = rows.filter((r) => r.sentenceIndex != null);
  assert.ok(placed.length > 0);
  assert.ok(
    placed.every((r) => r.sentenceNumber === r.sentenceIndex + 4),
    JSON.stringify(placed.map((r) => [r.sentenceIndex, r.sentenceNumber])),
  );
});

// A sentence typed in before the excerpt's first in IGT is sentence 1, so the
// export starts at snt1. Read back, that file went by its places: snt5 became
// 2, and opening it renamed every variable (s5b to s2b). The import now marks
// a file that numbers its sentences otherwise than 1, 2, 3, and the document
// goes by those numbers.
test('an excerpt with a sentence typed in before it exports and reads back the same', () => {
  const raw = rawFromPlan(planImport(parseUmrFile(EXCERPT).sentences, []));
  insertSentenceAtStart(raw);
  const first = new UmrDocument({ raw });
  assert.deepEqual(
    first.graph.sentences.map((s) => s.number),
    [1, 5, 6],
  );
  const out = first.toUmr();
  assert.match(out, /# :: snt1\n/);

  const again = rawFromPlan(planImport(parseUmrFile(out).sentences, []));
  const second = new UmrDocument({ raw: again });
  assert.deepEqual(
    second.graph.sentences.map((s) => s.number),
    [1, 5, 6],
  );
  assert.deepEqual(planRenumber(second.graph), []);
  assert.equal(second.toUmr(), out);
});

test('a file numbered 1, 2, 3 is not marked, and one with a gap is', () => {
  const plain = planImport(parseUmrFile(`${block(1)}\n${block(2)}`).sentences, []);
  assert.ok(plain.sentences.every((s) => s.meta.numbering === undefined));
  const gap = planImport(parseUmrFile(`${block(1)}\n${block(3)}`).sentences, []);
  assert.ok(gap.sentences.every((s) => s.meta.numbering === 'file'));
  const doc = new UmrDocument({ raw: rawFromPlan(gap) });
  assert.deepEqual(
    doc.graph.sentences.map((s) => s.number),
    [1, 3],
  );
  assert.deepEqual(planRenumber(doc.graph), []);
});
