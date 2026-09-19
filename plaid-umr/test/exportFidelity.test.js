// The export writes what the canvas shows, and says what it cannot: a part
// of a sentence its root does not reach, a graph kept as text, a word with a
// space in it, a concept PENMAN cannot carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { conceptProblem } from '../src/domain/format/penman.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { unreachedByRoot } from '../src/domain/sentenceGraph.js';
import { rawFromPlan } from './rawFromPlan.js';

const WORDS = 'Lindsay left in order to eat lunch .';
const file = (graph, alignment, doc = '') =>
  `################################################################################
# :: snt1\t${WORDS}
Index: 1 2 3 4 5 6 7 8
Words: ${WORDS}

# sentence level graph:
${graph}

# alignment:
${alignment}

# document level annotation:
${doc}

`;

const rawOf = (text) => rawFromPlan(planImport(parseUmrFile(text).sentences, []));
const load = (text) => new UmrDocument({ raw: rawOf(text) });

// The document `text` imports to, changed by `edit` first: what a canvas edit
// would have stored.
const loadEdited = (text, edit) => {
  const raw = structuredClone(rawOf(text));
  const concepts = raw.textLayers[0].tokenLayers[2].spanLayers[0];
  const idOf = (v) => concepts.spans.find((x) => x.metadata.umr.var === v).id;
  edit(raw, { concepts, relations: concepts.relationLayers[0], idOf });
  return new UmrDocument({ raw });
};

const LUNCH = `(s1l / leave-02
    :ARG0 (s1p / person)
    :purpose (s1e / eat-01
        :ARG1 (s1l2 / lunch
            :ARG1-of s1e)))`;
const LUNCH_ALIGNED = 's1l: 2-2\ns1p: 1-1\ns1e: 6-6\ns1l2: 7-7';
// The one edge into eat-01's cycle with lunch, deleted.
const cutPurpose = (raw, { relations, idOf }) => {
  relations.relations = relations.relations.filter(
    (x) => !(x.source === idOf('s1l') && x.target === idOf('s1e')),
  );
};

// A cycle with no way in (what deleting the one edge into it leaves) is a
// part of its own: it gets a root, and is reported.
test('a part the root does not reach gets a root and is reported', () => {
  const doc = loadEdited(file(LUNCH, LUNCH_ALIGNED), cutPurpose);
  const roots = doc.sentence(1).roots.map((r) => r.var);
  assert.equal(roots[0], 's1l');
  assert.equal(roots.length, 2);
  const problems = unreachedByRoot(doc.graph);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /and 1 node under it are not reached from the root s1l/);
  assert.ok(doc.problems.some((p) => p.code === 'unreached-by-root'));
});

test('the export writes only what the root reaches, with its alignment and triples', () => {
  const doc = loadEdited(
    file(
      LUNCH,
      LUNCH_ALIGNED,
      '(s1s0 / sentence :modal ((author :full-affirmative s1e) (author :full-affirmative s1l)))',
    ),
    cutPurpose,
  );
  const out = doc.toUmr();
  assert.doesNotMatch(out, /s1e/);
  assert.doesNotMatch(out, /s1l2/);
  assert.match(out, /\(author :full-affirmative s1l\)/);
});

// Made the root, a quoted clause reaches the old root through :quote: the
// old root is not a second one.
test('the old root a :quote reaches is no second root', () => {
  const doc = loadEdited(
    file(
      `(s1s / say-01
    :ARG1 (s1l / leave-02
        :quote s1s))`,
      's1s: 0-0\ns1l: 2-2',
    ),
    (raw, { concepts }) =>
      concepts.spans.forEach((x) => {
        const umr = x.metadata.umr;
        if (umr.var === 's1l') umr.root = true;
        else delete umr.root;
      }),
  );
  assert.deepEqual(
    doc.sentence(1).roots.map((n) => n.var),
    ['s1l'],
  );
});

// A word merged in IGT holds a space. The Words line is split on spaces, so
// it is written with `_`, and every alignment after it keeps its word.
test('a word with a space in it is one item on the Words line', () => {
  const r = structuredClone(rawOf(file('(s1e / eat-01)', 's1e: 6-6')));
  const words = r.textLayers[0].tokenLayers[1];
  const [w3, w4] = words.tokens.slice(2, 4);
  w3.end = w4.end;
  words.tokens.splice(3, 1);
  assert.equal(r.textLayers[0].text.body.slice(w3.begin, w3.end), 'in order');
  const merged = new UmrDocument({ raw: r });
  const out = merged.toUmr();
  assert.match(out, /Words: Lindsay left in_order to eat lunch \./);
  assert.match(out, /Index: 1 2 3 4 5 6 7\n/);
  assert.match(out, /s1e: 5-5/);
  // A file that splits it is refused on attach, not anchored a word late.
  assert.throws(
    () =>
      planImport(parseUmrFile(file('(s1e / eat-01)', 's1e: 6-6')).sentences, [], {
        existing: merged.graph,
      }),
    /Sentence 1 differs/,
  );
});

test('a concept PENMAN cannot carry is refused', () => {
  ['10:30', 'C#', 'a b', '(yards)', '"x"'].forEach((c) => assert.ok(conceptProblem(c), c));
  ['lunch', 'eat-01', 'have-org-role-92', '带-02'].forEach((c) =>
    assert.equal(conceptProblem(c), null),
  );
});

// A graph the import could not read is kept as text: text mode opens on it,
// and once the sentence has a node the graph shown is the one written.
test('a graph kept as text is written only while the sentence has no nodes', () => {
  const broken = load(file('(s1l / leave-02 :ARG0 (s1p / person)', 's1l: 2-2'));
  assert.match(broken.penmanOf(1), /^\(s1l \/ leave-02/);
  assert.match(broken.toUmr(), /\(s1l \/ leave-02 :ARG0 \(s1p \/ person\)/);
  const r = structuredClone(rawOf(file('(s1x / say-01)', 's1x: 2-2')));
  r.textLayers[0].tokenLayers[0].tokens[0].metadata.umr.rawGraph =
    '(s1l / leave-02 :ARG0 (s1p / person)';
  const out = new UmrDocument({ raw: r }).toUmr();
  assert.match(out, /\(s1x \/ say-01\)/);
  assert.doesNotMatch(out, /leave-02/);
});

test('an alignment written backwards is skipped with a warning, not the import', () => {
  const warnings = [];
  planImport(parseUmrFile(file('(s1e / eat-01)', 's1e: 6-5')).sentences, warnings);
  assert.ok(warnings.some((w) => /6-5, a range backwards/.test(w)));
});
