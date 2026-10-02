// Two people on one UMR document (Luke's ruling, 2026-10-03): UMR conflicts
// are per sentence. An edit conflicts only with a change made meanwhile to
// the graph of a sentence it writes (its nodes, edges, triples and record),
// and otherwise goes again by itself on the fresh document. Two pages write
// to one core in memory (twoWriterCore.js), which refuses a write stamped
// with a version the document has moved past, as core's strict mode does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { twoWriterCore } from './twoWriterCore.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'umr',
  'english_umr-0001.umr',
);

const start = async () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const core = twoWriterCore(rawFromPlan(planImport(parseUmrFile(text).sentences, [])));
  const a = await core.open('a');
  const b = await core.open('b');
  return { core, a, b };
};

// What the core holds now, read as a page reads it.
const stored = (core) => new UmrDocument({ raw: structuredClone(core.raw) });

const conceptsOf = (doc, index) => doc.sentence(index).nodes.map((n) => n.concept);

// Two nodes of one sentence, neither of which reaches the other.
function unrelated(doc, sentenceIndex, skip = new Set()) {
  const nodes = doc.sentence(sentenceIndex).nodes.filter((n) => !skip.has(n.id));
  for (const x of nodes) {
    for (const y of nodes) {
      if (
        x.id !== y.id &&
        !doc.wouldCycle(x.id, y.id, ':ARG1') &&
        !doc.wouldCycle(y.id, x.id, ':ARG1')
      )
        return [x, y];
    }
  }
  throw new Error(`No two unrelated nodes in sentence ${sentenceIndex}`);
}

const leaf = (doc, index) => doc.sentence(index).nodes.find((n) => !n.root && !n.out.length);
const refusals = (page) => page.errors.filter((e) => e?.status === 409);

test('a node added to one sentence goes again after another person changed another sentence', async () => {
  const { core, a, b } = await start();
  assert.ok(await b.doc.setConcept(leaf(b.doc, 2).id, 'theirs'));
  const root = a.doc.sentence(1).nodes.find((n) => n.root);
  const made = await a.doc.createNode({
    sentenceIndex: 1,
    concept: 'mine',
    parentId: root.id,
    role: ':mod',
  });
  assert.ok(made, 'the node was written');
  assert.deepEqual(refusals(a), []);
  // Refused once for the version, then sent again on the fresh one.
  assert.deepEqual(
    core.refused.map((r) => r.who),
    ['a'],
  );
  const now = stored(core);
  assert.ok(conceptsOf(now, 1).includes('mine'));
  assert.ok(conceptsOf(now, 2).includes('theirs'));
  // Both on A's screen once the queue drains.
  await a.doc.whenSaved();
  assert.ok(conceptsOf(a.doc, 1).includes('mine'));
  assert.ok(conceptsOf(a.doc, 2).includes('theirs'));
});

test('a concept, a role, an edge and a rename each go again past a change to another sentence', async () => {
  const { core, a, b } = await start();
  const edits = [
    () => a.doc.setConcept(leaf(a.doc, 1).id, 'mine'),
    () => {
      const e = a.doc.sentence(1).edges.find((x) => x.role !== ':ARG2');
      return a.doc.setRole(e.id, ':ARG2');
    },
    () => {
      const [x, y] = unrelated(a.doc, 1);
      return a.doc.createEdge(x.id, y.id, ':ARG1');
    },
    () => a.doc.setVariable(leaf(a.doc, 1).id, 's1zz'),
  ];
  let k = 0;
  for (const edit of edits) {
    k += 1;
    // B changes sentence 3 each time, so each of A's edits is stamped with
    // a version the document has moved past.
    assert.ok(await b.doc.setConcept(leaf(b.doc, 3).id, `theirs${k}`));
    assert.ok(await edit(), `edit ${k} was written`);
  }
  assert.deepEqual(refusals(a), []);
  assert.equal(core.refused.filter((r) => r.who === 'a').length, edits.length);
  const now = stored(core);
  assert.ok(conceptsOf(now, 1).includes('mine'));
  assert.ok(now.sentence(1).edges.some((e) => e.role === ':ARG2'));
  assert.ok(now.sentence(1).nodes.some((n) => n.var === 's1zz'));
  assert.ok(conceptsOf(now, 3).includes(`theirs${edits.length}`));
});

test('text mode on one sentence goes again after another person changed another sentence', async () => {
  const { core, a, b } = await start();
  assert.ok(await b.doc.setConcept(leaf(b.doc, 2).id, 'theirs'));
  const root = a.doc.sentence(1).nodes.find((n) => n.root);
  const text = a.doc
    .penmanOf(1)
    .replace(`(${root.var} / ${root.concept}`, `(${root.var} / ${root.concept} :mod (s1zz / huge)`);
  assert.notEqual(text, a.doc.penmanOf(1));
  assert.notEqual(await a.doc.applyPenman(1, text), false);
  assert.deepEqual(refusals(a), []);
  const now = stored(core);
  assert.ok(conceptsOf(now, 1).includes('huge'));
  assert.ok(conceptsOf(now, 2).includes('theirs'));
});

test('edits waiting behind a refused one go after it, each judged by its own sentence', async () => {
  const { core, a, b } = await start();
  assert.ok(await b.doc.setConcept(leaf(b.doc, 2).id, 'theirs'));
  const first = a.doc.setConcept(leaf(a.doc, 1).id, 'mine');
  const second = a.doc.setConcept(leaf(a.doc, 4).id, 'mine-too');
  assert.ok(await first);
  assert.ok(await second);
  assert.deepEqual(refusals(a), []);
  const now = stored(core);
  assert.ok(conceptsOf(now, 1).includes('mine'));
  assert.ok(conceptsOf(now, 4).includes('mine-too'));
});

test('an edit to the sentence another person changed is refused, and nothing of it is written', async () => {
  const { core, a, b } = await start();
  const [x, y] = unrelated(a.doc, 1);
  assert.ok(await b.doc.setConcept(x.id, 'theirs'));
  assert.equal(await a.doc.setConcept(y.id, 'mine'), false);
  assert.equal(refusals(a).length, 1);
  const now = stored(core);
  assert.ok(conceptsOf(now, 1).includes('theirs'));
  assert.ok(!conceptsOf(now, 1).includes('mine'));
  // A's screen shows what is stored.
  await a.doc.whenSaved();
  assert.ok(conceptsOf(a.doc, 1).includes('theirs'));
});

test("a node added where another person's node went in meanwhile is refused", async () => {
  const { core, a, b } = await start();
  assert.ok(await b.doc.createNode({ sentenceIndex: 2, concept: 'theirs' }));
  assert.equal(await a.doc.createNode({ sentenceIndex: 2, concept: 'mine' }), false);
  assert.equal(refusals(a).length, 1);
  const now = stored(core);
  assert.ok(conceptsOf(now, 2).includes('theirs'));
  assert.ok(!conceptsOf(now, 2).includes('mine'));
});

test('a triple between two sentences makes a change to either one a conflict', async () => {
  const { core, a, b } = await start();
  // B links sentence 2 to sentence 6 by a coreference triple.
  const n2 = leaf(b.doc, 2);
  const n6 = leaf(b.doc, 6);
  assert.ok(await b.doc.createTriple({ source: n2.id, target: n6.id, rel: ':same-entity' }));
  // A, not having read it, edits sentence 6: refused.
  assert.equal(await a.doc.setConcept(leaf(a.doc, 6).id, 'mine'), false);
  assert.equal(refusals(a).length, 1);
  // B links them again the other way. A edits sentence 7: sent again.
  assert.ok(await b.doc.createTriple({ source: n6.id, target: n2.id, rel: ':subset-of' }));
  assert.ok(await a.doc.setConcept(leaf(a.doc, 7).id, 'mine'));
  assert.equal(refusals(a).length, 1);
  assert.ok(conceptsOf(stored(core), 7).includes('mine'));
});

test('triples hung on one constant from two sentences do not conflict', async () => {
  const { core, a, b } = await start();
  const author = (doc) => doc.constantNode('author');
  const before = author(stored(core)).docOut.length;
  assert.ok(
    await b.doc.createTriple({
      source: 'author',
      target: leaf(b.doc, 2).id,
      rel: ':full-affirmative',
    }),
  );
  assert.ok(
    await a.doc.createTriple({
      source: 'author',
      target: leaf(a.doc, 3).id,
      rel: ':full-affirmative',
    }),
  );
  assert.deepEqual(refusals(a), []);
  const now = stored(core);
  assert.equal(now.graph.constants.filter((c) => c.var === 'author').length, 1);
  assert.equal(author(now).docOut.length, before + 2);
});

test('two people making the same new constant at once conflict, and the document gets one', async () => {
  const { core, a, b } = await start();
  // `document-creation-time` is in the file. A constant no triple uses yet:
  const name = 'purpose';
  const known = await import('../src/domain/format/inventory.js');
  const constant = known.DOC_CONSTANTS.find(
    (c) => !stored(core).graph.constants.some((x) => x.var === c),
  );
  assert.ok(constant, `a constant the fixture does not use (not ${name})`);
  assert.ok(
    await b.doc.createTriple({
      source: constant,
      target: leaf(b.doc, 2).id,
      rel: ':full-affirmative',
    }),
  );
  assert.equal(
    await a.doc.createTriple({
      source: constant,
      target: leaf(a.doc, 3).id,
      rel: ':full-affirmative',
    }),
    false,
  );
  assert.equal(refusals(a).length, 1);
  assert.equal(stored(core).graph.constants.filter((c) => c.var === constant).length, 1);
});

test('a node deleted while another person linked to it from another sentence is refused', async () => {
  const { core, a, b } = await start();
  const target = leaf(b.doc, 2);
  assert.ok(
    await b.doc.createTriple({ source: leaf(b.doc, 5).id, target: target.id, rel: ':same-entity' }),
  );
  assert.equal(await a.doc.deleteNode(target.id), false);
  assert.equal(refusals(a).length, 1);
  assert.ok(stored(core).node(target.id), 'the node is still there');
});

test("another person's open that only fits records of other sentences does not refuse an edit", async () => {
  const { core, a, b } = await start();
  // Another page writes one record's metadata, as an open's repair would.
  const other = core.client('c');
  const record = b.doc.layerInfo.nodeTokenLayer.tokens.find(
    (t) => t.metadata?.umr && t.begin >= b.doc.sentence(4).begin && t.begin < b.doc.sentence(4).end,
  );
  assert.ok(record);
  await other.tokens.patchMetadata(record.id, [{ op: 'set', path: ['umr', 'note'], value: 'x' }]);
  assert.ok(await a.doc.setConcept(leaf(a.doc, 1).id, 'mine'));
  assert.deepEqual(refusals(a), []);
  // The same, in A's own sentence: refused.
  const own = b.doc.layerInfo.nodeTokenLayer.tokens.find(
    (t) => t.metadata?.umr && t.begin >= b.doc.sentence(1).begin && t.begin < b.doc.sentence(1).end,
  );
  await other.tokens.patchMetadata(own.id, [{ op: 'set', path: ['umr', 'note'], value: 'y' }]);
  assert.equal(await a.doc.setConcept(leaf(a.doc, 1).id, 'mine-again'), false);
  assert.equal(refusals(a).length, 1);
});

// Seeded, so a failure names the run that found it.
function random(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

test('two people editing at random: an edit is refused exactly when the other changed its sentence since it last read', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { core, a, b } = await start();
    const rand = random(seed);
    const pages = { a, b };
    // The model: the writes that landed, in order, by sentence, and how far
    // into them each page has read.
    const landed = [];
    const read = { a: 0, b: 0 };
    const expected = new Map();
    const sentences = a.doc.sentences.length;
    for (let round = 0; round < 30; round++) {
      const who = rand() < 0.5 ? 'a' : 'b';
      const page = pages[who];
      const index = 1 + Math.floor(rand() * Math.min(sentences, 6));
      const nodes = page.doc.sentence(index).nodes;
      const node = nodes[Math.floor(rand() * nodes.length)];
      const concept = `c${seed}-${round}`;
      const add = rand() < 0.3;
      const others = landed.slice(read[who]).filter((w) => w.who !== who);
      const conflict = others.some((w) => w.sentence === index);
      const before = refusals(page).length;
      const result = add
        ? await page.doc.createNode({
            sentenceIndex: index,
            concept,
            parentId: node.id,
            role: ':mod',
          })
        : await page.doc.setConcept(node.id, concept);
      await page.doc.whenSaved();
      const where = `seed ${seed}, round ${round}, ${who} in sentence ${index}`;
      if (conflict) {
        assert.equal(result, false, where);
        assert.equal(refusals(page).length, before + 1, where);
      } else {
        assert.ok(result, where);
        assert.equal(refusals(page).length, before, where);
        landed.push({ who, sentence: index });
        if (add) expected.set(result.nodeId, concept);
        else expected.set(node.id, concept);
      }
      read[who] = landed.length;
    }
    const now = stored(core);
    for (const [id, concept] of expected) {
      // The later write to a node wins: only the last one is expected.
      assert.equal(now.node(id)?.concept, concept, `seed ${seed}: ${id}`);
    }
  }
});

test('a refused edit tells the screen so, and one sent again does not', async () => {
  const { a, b } = await start();
  const [x, y] = unrelated(a.doc, 1);
  assert.ok(await b.doc.setConcept(x.id, 'theirs'));
  let told = 0;
  const onRefused = () => (told += 1);
  assert.equal(await a.doc.setConcept(y.id, 'mine', { onRefused }), false);
  assert.equal(told, 1);
  assert.ok(await b.doc.setConcept(leaf(b.doc, 2).id, 'theirs'));
  assert.ok(await a.doc.setConcept(y.id, 'mine', { onRefused }));
  assert.ok(
    await a.doc.createNode({
      sentenceIndex: 1,
      concept: 'mine',
      parentId: y.id,
      role: ':mod',
      onRefused,
    }),
  );
  assert.equal(told, 1);
});
