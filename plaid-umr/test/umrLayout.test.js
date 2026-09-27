import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  placeRow,
  layoutSentence,
  pointOn,
  stageLeftOffset,
  revealShift,
  DEFAULT_OPTIONS,
} from '../src/domain/umrLayout.js';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'umr');

const noOverlap = (positions, items, gap) => {
  const sorted = [...items].sort((a, b) => positions.get(a.id) - positions.get(b.id));
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const aRight = positions.get(a.id) + a.width / 2;
    const bLeft = positions.get(b.id) - b.width / 2;
    assert.ok(bLeft >= aRight + gap - 1e-6, `${a.id} and ${b.id} overlap`);
  }
};

test('a row with room leaves every node at its preference', () => {
  const items = [
    { id: 'a', pref: 0, tie: 0, width: 40 },
    { id: 'b', pref: 100, tie: 1, width: 40 },
    { id: 'c', pref: 200, tie: 2, width: 40 },
  ];
  const xs = placeRow(items, 10);
  assert.deepEqual([...xs.values()], [0, 100, 200]);
});

test('two nodes over one token part symmetrically', () => {
  const items = [
    { id: 'a', pref: 100, tie: 0, width: 40 },
    { id: 'b', pref: 100, tie: 1, width: 40 },
  ];
  const xs = placeRow(items, 10);
  assert.equal(xs.get('a'), 75);
  assert.equal(xs.get('b'), 125);
  noOverlap(xs, items, 10);
});

test('a crowded row spreads without overlap and keeps order', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    id: `n${i}`,
    pref: 30 * i + (i % 3) * 5,
    tie: i,
    width: 50 + (i % 4) * 10,
  }));
  const xs = placeRow(items, 8);
  noOverlap(xs, items, 8);
  const order = items.map((it) => xs.get(it.id));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
});

// A three-node sentence: leave-02 :ARG0 person :purpose eat-01, eat-01 :ARG0
// person (re-entrant).
const sentenceFixture = () => {
  const words = [
    { id: 'w1', index: 1, begin: 0, end: 7 },
    { id: 'w2', index: 2, begin: 8, end: 12 },
    { id: 'w3', index: 3, begin: 13, end: 16 },
  ];
  const mk = (id, v, concept, wordIds, sentence = 1) => ({
    id,
    var: v,
    concept,
    wordIds,
    pieces: [{ begin: 0, end: 1 }],
    sentence,
    out: [],
    in: [],
    attrs: [],
  });
  const leave = mk('n1', 's1l', 'leave-02', ['w2']);
  const person = mk('n2', 's1p', 'person', []);
  const eat = mk('n3', 's1e', 'eat-01', ['w3']);
  const e1 = { id: 'e1', source: 'n1', target: 'n2', role: ':ARG0', order: 0 };
  const e2 = { id: 'e2', source: 'n1', target: 'n3', role: ':purpose', order: 1 };
  const e3 = { id: 'e3', source: 'n3', target: 'n2', role: ':ARG0', order: 0 };
  leave.out.push(e1, e2);
  person.in.push(e1, e3);
  eat.in.push(e2);
  eat.out.push(e3);
  const nodesById = new Map([
    ['n1', leave],
    ['n2', person],
    ['n3', eat],
  ]);
  const sentence = {
    index: 1,
    words,
    nodes: [leave, person, eat],
    edges: [e1, e2, e3],
    roots: [leave],
  };
  return { sentence, nodesById };
};

test('layout rows follow tree depth and marks the re-entrant edge', () => {
  const { sentence, nodesById } = sentenceFixture();
  const columns = new Map([
    ['w1', { x: 40 }],
    ['w2', { x: 120 }],
    ['w3', { x: 200 }],
  ]);
  const layout = layoutSentence(sentence, nodesById, { columns, sizes: new Map(), sentenceX: 40 });
  assert.equal(layout.nodes.get('n1').row, 0);
  assert.equal(layout.nodes.get('n2').row, 1);
  assert.equal(layout.nodes.get('n3').row, 1);
  // The predicate sits over its own word.
  assert.equal(layout.nodes.get('n1').x, 120);
  const byId = Object.fromEntries(layout.edges.map((e) => [e.id, e]));
  assert.equal(byId.e1.tree, true);
  assert.equal(byId.e2.tree, true);
  assert.equal(byId.e3.tree, false);
  assert.equal(layout.rows, 2);
});

test('each row is as tall as its own tallest node', () => {
  const { sentence, nodesById } = sentenceFixture();
  const columns = new Map([
    ['w1', { x: 40 }],
    ['w2', { x: 120 }],
    ['w3', { x: 200 }],
  ]);
  // A tall leaf does not make the root's row tall: the second row starts
  // under the root's own box.
  const sizes = new Map([
    ['n1', { width: 90, height: 30 }],
    ['n2', { width: 80, height: 140 }],
    ['n3', { width: 80, height: 30 }],
  ]);
  const layout = layoutSentence(sentence, nodesById, { columns, sizes, sentenceX: 40 });
  const { marginTop, edgeRoom } = DEFAULT_OPTIONS;
  assert.equal(layout.nodes.get('n1').y, marginTop);
  assert.equal(layout.nodes.get('n2').y, marginTop + 30 + edgeRoom);
});

test('a child under its parent drops straight down', () => {
  const { sentence, nodesById } = sentenceFixture();
  // eat-01 five pixels to the right of leave-02: under it, but not centred.
  const columns = new Map([
    ['w1', { x: 40 }],
    ['w2', { x: 120 }],
    ['w3', { x: 125 }],
  ]);
  const sizes = new Map([
    ['n1', { width: 200, height: 30 }],
    ['n2', { width: 60, height: 30 }],
    ['n3', { width: 60, height: 30 }],
  ]);
  const layout = layoutSentence(sentence, nodesById, { columns, sizes, sentenceX: 40 });
  const e2 = layout.edges.find((e) => e.id === 'e2');
  const eat = layout.nodes.get('n3');
  const xs = [...e2.path.matchAll(/[ML] ([\d.-]+) /g)].map((m) => Number(m[1]));
  assert.deepEqual(xs, [eat.x, eat.x]);
});

// Lunch with person moved after :purpose: eat-01 now holds person as its tree
// child, two rows down, and leave-02's :ARG0 is the re-entrant edge. Its
// curve bows out to the left of the graph, where the margin's constants are,
// so the layout's extent reaches that far and the stage is padded by it.
test('the extent holds a re-entrant edge that bows out left of the graph', () => {
  const { sentence, nodesById } = sentenceFixture();
  const [e1, e2, e3] = sentence.edges;
  e1.order = 1;
  e2.order = 0;
  nodesById.get('n2').wordIds = ['w1'];
  const columns = new Map([
    ['w1', { x: 40 }],
    ['w2', { x: 120 }],
    ['w3', { x: 200 }],
  ]);
  const sizes = new Map([
    ['n1', { width: 240, height: 90 }],
    ['n2', { width: 80, height: 30 }],
    ['n3', { width: 200, height: 70 }],
  ]);
  const layout = layoutSentence(sentence, nodesById, { columns, sizes, sentenceX: 40 });
  const edge = layout.edges.find((e) => e.id === e1.id);
  assert.equal(edge.tree, false);
  assert.equal(layout.edges.find((e) => e.id === e3.id).tree, true);
  const xs = Array.from({ length: 25 }, (_, i) => pointOn(edge.curve, i / 24)[0]);
  const boxLeft = Math.min(...[...layout.nodes.values()].map((p) => p.x - p.width / 2));
  assert.ok(Math.min(...xs) < Math.min(0, boxLeft), 'the curve bows out past the boxes');
  assert.ok(Math.min(...xs) >= layout.left);
  assert.ok(Math.max(...xs) <= layout.right);
});

// Across every sentence of the seven released corpora, with estimated sizes:
// no node overlaps another, and a re-entrant edge's label sits on no node
// and no other label. Before the labels were placed along their curve with
// these checks, 123 of the 427 sat on a node and 192 on another label. A few
// of the densest Arapaho and Kukama sentences leave nowhere free at all.
test('labels clear the boxes and each other in every corpus', () => {
  const box = (x, y, w, h) => ({ l: x - w / 2, r: x + w / 2, t: y - h / 2, b: y + h / 2 });
  const overlap = (a, b) =>
    Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) *
    Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  let labels = 0;
  const colliding = [];
  for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.umr'))) {
    const text = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
    const plan = planImport(parseUmrFile(text).sentences, []);
    const graph = new UmrDocument({ raw: rawFromPlan(plan) }).graph;
    graph.sentences.forEach((s) => {
      if (!s.nodes.length) return;
      let x = 40;
      const columns = new Map();
      s.words.forEach((w) => {
        const width = 14 + 8 * w.text.length;
        columns.set(w.id, { x: x + width / 2 });
        x += width + 14;
      });
      const layout = layoutSentence(s, graph.nodesById, { columns, sizes: new Map() });
      const nodes = [...layout.nodes.values()].map((p) => ({
        l: p.x - p.width / 2,
        r: p.x + p.width / 2,
        t: p.y,
        b: p.y + p.height,
      }));
      nodes.forEach((a, i) =>
        nodes.slice(i + 1).forEach((b) => assert.equal(overlap(a, b), 0, `${file} s${s.index}`)),
      );
      const pills = layout.edges.map((e) =>
        box(e.label.x, e.label.y, DEFAULT_OPTIONS.pillWidth(e.role), DEFAULT_OPTIONS.pillHeight),
      );
      layout.edges.forEach((e, i) => {
        if (e.tree) return;
        labels++;
        const hit =
          nodes.some((n) => overlap(pills[i], n) > 4) ||
          pills.some((p, j) => j !== i && overlap(pills[i], p) > 4);
        if (hit) colliding.push(`${file} s${s.index} ${e.role}`);
      });
    });
  }
  assert.equal(labels, 427);
  assert.ok(colliding.length <= 8, colliding.join('\n'));
  assert.ok(
    colliding.every((c) => /^(arapaho|kukama)/.test(c)),
    colliding.join('\n'),
  );
});

// The canvas scrolls sideways and the document constants are pinned to its
// visible left edge. An RTL scroller counts scrollLeft from its RIGHT edge,
// negative leftwards, and opens there.
test('the stage offset is the distance scrolled from the canvas\u2019s left edge', () => {
  const box = { scrollLeft: 0, scrollWidth: 1000, clientWidth: 400 };
  assert.equal(stageLeftOffset(box, 'ltr'), 0);
  assert.equal(stageLeftOffset(box, 'rtl'), 600);
  assert.equal(stageLeftOffset({ ...box, scrollLeft: 250 }, 'ltr'), 250);
  assert.equal(stageLeftOffset({ ...box, scrollLeft: -250 }, 'rtl'), 350);
  // Scrolled to the far end, either way, the stage's left edge is in view.
  assert.equal(stageLeftOffset({ ...box, scrollLeft: 600 }, 'ltr'), 600);
  assert.equal(stageLeftOffset({ ...box, scrollLeft: -600 }, 'rtl'), 0);
  // Nothing overflows: there is nowhere to scroll.
  assert.equal(stageLeftOffset({ scrollLeft: 0, scrollWidth: 400, clientWidth: 400 }, 'rtl'), 0);
});

// A re-entrant edge between two neighbours in one row was a dip shorter than
// its own label, which covered all of it but the arrowhead ("prdii" to
// "har-nuu" in the Lamkang demo). In every corpus, a third of each such
// curve at least shows past its label.
test('a re-entrant edge in one row shows past its label', () => {
  const short = [];
  let dips = 0;
  for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.umr'))) {
    const text = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
    const plan = planImport(parseUmrFile(text).sentences, []);
    const graph = new UmrDocument({ raw: rawFromPlan(plan) }).graph;
    graph.sentences.forEach((s) => {
      if (!s.nodes.length) return;
      let x = 40;
      const columns = new Map();
      s.words.forEach((w) => {
        const width = 14 + 8 * w.text.length;
        columns.set(w.id, { x: x + width / 2 });
        x += width + 14;
      });
      const layout = layoutSentence(s, graph.nodesById, { columns, sizes: new Map() });
      layout.edges.forEach((e) => {
        if (e.tree || layout.nodes.get(e.source).row !== layout.nodes.get(e.target).row) return;
        dips++;
        const half = DEFAULT_OPTIONS.pillWidth(e.role) / 2;
        const halfH = DEFAULT_OPTIONS.pillHeight / 2;
        let shown = 0;
        for (let i = 1; i < 24; i++) {
          const [px, py] = pointOn(e.curve, i / 24);
          if (Math.abs(px - e.label.x) > half || Math.abs(py - e.label.y) > halfH) shown++;
        }
        if (shown < 8) short.push(`${file} s${s.index} ${e.role} ${shown}/23`);
      });
    });
  }
  assert.ok(dips > 20, `${dips} same-row re-entrant edges`);
  assert.deepEqual(short, []);
});

// Unaligned siblings all want their parent's x, so the file order decides
// theirs. It runs the way the sentence reads: in an RTL sentence the first of
// them is the RIGHTMOST, as the first word is.
const siblingsFixture = () => {
  const words = [
    { id: 'w1', index: 1, begin: 0, end: 3 },
    { id: 'w2', index: 2, begin: 4, end: 7 },
  ];
  const mk = (id, v, concept, wordIds) => ({
    id,
    var: v,
    concept,
    wordIds,
    pieces: [{ begin: 0, end: 1 }],
    sentence: 1,
    out: [],
    in: [],
    attrs: [],
  });
  const and = mk('a', 's1a', 'and', ['w1']);
  const ops = ['x', 'y', 'z'].map((k) => mk(k, `s1${k}`, 'thing', []));
  const edges = ops.map((op, i) => ({
    id: `e${i}`,
    source: 'a',
    target: op.id,
    role: `:op${i + 1}`,
    order: i,
  }));
  and.out.push(...edges);
  ops.forEach((op, i) => op.in.push(edges[i]));
  const nodesById = new Map([and, ...ops].map((n) => [n.id, n]));
  const sentence = { index: 1, words, nodes: [and, ...ops], edges, roots: [and] };
  return { sentence, nodesById };
};

test('unaligned siblings run in file order along the reading direction', () => {
  const { sentence, nodesById } = siblingsFixture();
  const columns = new Map([
    ['w1', { x: 300 }],
    ['w2', { x: 100 }],
  ]);
  const order = (direction) => {
    const layout = layoutSentence(
      sentence,
      nodesById,
      { columns, sizes: new Map(), sentenceX: 300 },
      direction ? { direction } : {},
    );
    return ['x', 'y', 'z'].sort((p, q) => layout.nodes.get(p).x - layout.nodes.get(q).x);
  };
  // Left to right, by default and when said.
  assert.deepEqual(order(), ['x', 'y', 'z']);
  assert.deepEqual(order('ltr'), ['x', 'y', 'z']);
  // Right to left: op1 on the right, where reading starts.
  assert.deepEqual(order('rtl'), ['z', 'y', 'x']);
});

test('the reading direction reorders only ties, never nodes over their own words', () => {
  const items = [
    { id: 'a', pref: 100, tie: 0, width: 40 },
    { id: 'b', pref: 300, tie: 1, width: 40 },
  ];
  const flipped = items.map((it) => ({ ...it, tie: -it.tie }));
  assert.deepEqual([...placeRow(items, 10)], [...placeRow(flipped, 10)]);
});

// A node reached by the keyboard is scrolled clear of the frozen constants
// lane. Focus alone leaves a node that is partly on screen where it is, and
// with the lane opaque that could be all of what showed of it.
test('a focused node is scrolled clear of the constants lane and the far edge', () => {
  const view = { left: 0, right: 800 };
  // Under the lane: back to its right edge and a little more.
  assert.equal(revealShift({ left: -72, right: 210 }, view, 196), -72 - 204);
  assert.equal(revealShift({ left: 13, right: 175 }, view, 196), 13 - 204);
  // Clear already.
  assert.equal(revealShift({ left: 222, right: 504 }, view, 196), 0);
  // Past the far edge: along until its end shows.
  assert.equal(revealShift({ left: 600, right: 900 }, view, 196), 900 - 792);
  // Wider than the room: its start wins.
  assert.equal(revealShift({ left: 400, right: 1400 }, view, 196), 400 - 204);
});
