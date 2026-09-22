// Pure-fn tests for the dependency tree's geometry (arcLayout.js): which level
// each arc is drawn at, how tall the tree that holds them has to be, and where
// every piece of one arc goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeArcLayout,
  computeLowerBand,
  handArcPath,
  levelAmong,
  buildIndexById,
  assignLevels,
  arcHeight,
  arcPath,
  arrowPoints,
  bandArc,
  dragPreview,
  grabRect,
  labelXOf,
  reachOf,
  sortByLabelX,
  svgWidth,
  treeArc,
  treeFrame,
  wordInColumn,
  TREE_OVERHANG,
  TOKEN_BASELINE,
  ARC_BASE,
  ARC_STEP,
  ARC_CORNER,
  LOWER_BAND_TOP,
  ROOT_Y,
  ROOT_BAR_HEIGHT,
  ROOT_LINE,
  ROOT_GRAB,
} from '../src/utils/arcLayout.js';

// A sentence of `n` words, one lemma span per word, named w0..w(n-1) / s0..s(n-1).
const sentence = (n) => {
  const tokens = Array.from({ length: n }, (_, i) => ({ id: `w${i}` }));
  const lemmaSpans = tokens.map((t, i) => ({ id: `s${i}`, tokens: [t.id] }));
  return { tokens, lemmaSpans, indexById: buildIndexById(tokens, lemmaSpans) };
};

// `[head, dependent]` pairs, by column, as relations over those lemma spans.
const arcs = (pairs) =>
  pairs.map(([head, dep], i) => ({ id: `r${i}`, source: `s${head}`, target: `s${dep}` }));

const levelsOf = (n, pairs) => {
  const { indexById } = sentence(n);
  const { levels } = computeArcLayout(arcs(pairs), indexById);
  return pairs.map((_, i) => levels.get(`r${i}`));
};

test('an arc sits one level above the arc it encloses', () => {
  // 0 → 3 encloses 1 → 2.
  assert.deepEqual(levelsOf(4, [[1, 2]]), [1]);
  assert.deepEqual(
    levelsOf(4, [
      [1, 2],
      [0, 3],
    ]),
    [1, 2],
  );
});

test('the order the relations arrive in does not change the stack', () => {
  assert.deepEqual(
    levelsOf(4, [
      [0, 3],
      [1, 2],
    ]),
    [2, 1],
  );
});

test('arcs standing side by side share a level', () => {
  // Two arcs meeting at word 2 are still side by side: nothing is between them.
  assert.deepEqual(
    levelsOf(5, [
      [0, 2],
      [2, 4],
    ]),
    [1, 1],
  );
  // Wholly separate arcs, likewise.
  assert.deepEqual(
    levelsOf(5, [
      [0, 1],
      [3, 4],
    ]),
    [1, 1],
  );
});

test('arcs that cross are stacked, narrower one below', () => {
  // 0 → 5 and 2 → 8 overlap without either enclosing the other: a
  // non-projective pair still crosses on screen, but not at the same height.
  const [a, b] = levelsOf(9, [
    [0, 5],
    [2, 8],
  ]);
  assert.notEqual(a, b);
});

test('several arcs out of one head climb one level at a time', () => {
  // A head with three dependents to its right: each arc encloses the last.
  assert.deepEqual(
    levelsOf(5, [
      [0, 1],
      [0, 2],
      [0, 3],
    ]),
    [1, 2, 3],
  );
});

test('no two arcs sharing a word are drawn at the same height', () => {
  // A projective tree over ten words, built as nested phrases.
  const pairs = [
    [1, 0], // nsubj
    [1, 5], // obl, over the whole phrase
    [5, 2],
    [5, 3],
    [5, 4],
    [1, 9],
    [9, 6],
    [9, 7],
    [9, 8],
  ];
  const { indexById } = sentence(10);
  const { levels } = computeArcLayout(arcs(pairs), indexById);
  const drawn = pairs.map(([h, d], i) => ({
    left: Math.min(h, d),
    right: Math.max(h, d),
    level: levels.get(`r${i}`),
  }));

  for (const a of drawn) {
    for (const b of drawn) {
      if (a === b) continue;
      const sharesAWord = Math.max(a.left, b.left) < Math.min(a.right, b.right);
      if (sharesAWord) assert.notEqual(a.level, b.level);
      // And what encloses is drawn above what it encloses.
      if (a.left <= b.left && a.right >= b.right && (a.left < b.left || a.right > b.right)) {
        assert.ok(a.level > b.level);
      }
    }
  }
});

test('a root relation takes no room in the stack', () => {
  const { indexById } = sentence(3);
  const root = { id: 'root', source: 's1', target: 's1' };
  const { levels, maxLevel } = computeArcLayout([root, ...arcs([[1, 0]])], indexById);
  assert.equal(levels.has('root'), false);
  assert.equal(maxLevel, 1);
});

test('a relation whose endpoints are not on screen is left out', () => {
  const { indexById } = sentence(3);
  const stale = { id: 'stale', source: 'sX', target: 's0' };
  const { levels, maxLevel } = computeArcLayout([stale], indexById);
  assert.equal(levels.has('stale'), false);
  assert.equal(maxLevel, 0);
});

test('a token stands in for its own lemma span, and a multi-word span for its first word', () => {
  const tokens = [{ id: 'w0' }, { id: 'w1' }, { id: 'w2' }];
  const lemmaSpans = [
    { id: 's01', tokens: ['w0', 'w1'] },
    { id: 's2', tokens: ['w2'] },
  ];
  const indexById = buildIndexById(tokens, lemmaSpans);
  assert.equal(indexById.get('s01'), 0);
  assert.equal(indexById.get('w1'), 1);
  assert.equal(indexById.get('s2'), 2);
});

test('the tree is as tall as its deepest stack, and the grid reserves the same', () => {
  const { indexById } = sentence(8);
  const shallow = computeArcLayout(
    arcs([
      [0, 1],
      [0, 2],
      [0, 3],
    ]),
    indexById,
  );
  const deep = computeArcLayout(
    arcs([
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 5],
      [0, 6],
      [0, 7],
    ]),
    indexById,
  );
  assert.equal(deep.treeHeight - shallow.treeHeight, arcHeight(7) - arcHeight(3));
  // The padding is DERIVED from the overhang and the words' baseline inside
  // the overlay, not folded by hand: the CSS offset, the measured word y and
  // the arc baseline all read the same two numbers.
  assert.equal(deep.gridPaddingTop, deep.treeHeight - (TREE_OVERHANG + TOKEN_BASELINE + 5));
  assert.equal(TREE_OVERHANG + TOKEN_BASELINE + 5, 85);

  // However few arcs a sentence has, there is still a tree to draw into: a
  // floor keeps the ROOT bar a draggable distance above the words.
  assert.equal(computeArcLayout([], indexById).treeHeight, 150);
  assert.equal(computeArcLayout(arcs([[0, 1]]), indexById).treeHeight, 150);
});

test('each level adds a fixed step', () => {
  assert.equal(arcHeight(1), ARC_BASE);
  assert.equal(arcHeight(3), ARC_BASE + 2 * ARC_STEP);
});

test('a tree drawn at another scale passes its own base and step', () => {
  // The citation card's stack compresses to fit a panel. Only the size
  // changes: the order the levels come in is the same.
  assert.equal(arcHeight(3, { base: 10, step: 5 }), 20);
  assert.ok(arcHeight(2, { base: 10, step: 5 }) < arcHeight(3, { base: 10, step: 5 }));
});

test('levels can be assigned over plain intervals, whatever drew them', () => {
  // The card works in word columns and has no relation ids, so it stacks
  // through this rather than through computeArcLayout.
  const { levels, maxLevel } = assignLevels([
    { id: 'wide', left: 0, right: 4 },
    { id: 'inner', left: 1, right: 2 },
    { id: 'beside', left: 4, right: 5 },
  ]);
  assert.equal(levels.get('inner'), 1);
  assert.equal(levels.get('wide'), 2);
  assert.equal(levels.get('beside'), 1);
  assert.equal(maxLevel, 2);
});

// The turn out of the rise, read back off a path: where the first curve ends.
const turnWidth = (d, fromX) => Math.abs(Number(d.match(/Q [-\d.]+ [-\d.]+ ([-\d.]+)/)[1]) - fromX);

test('an arc runs flat at its own height', () => {
  const d = arcPath(100, 300, 200, 50);
  const run = [...d.matchAll(/Q [-\d.]+ ([-\d.]+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(run, [150, 150]); // baseline 200, height 50, both turns level
  assert.ok(d.startsWith('M 100 200'));
  assert.ok(d.endsWith('300 200'));
});

test('every arc turns through the same width, which is what stops them crossing', () => {
  // A wide arc that turned more gently than the narrow one nested under it
  // would climb more slowly and cut through it near their shared endpoint.
  assert.equal(turnWidth(arcPath(0, 200, 100, 30), 0), ARC_CORNER);
  assert.equal(turnWidth(arcPath(0, 2000, 100, 90), 0), ARC_CORNER);
  // Leftward, likewise.
  assert.equal(turnWidth(arcPath(2000, 0, 100, 90), 2000), ARC_CORNER);
});

test('an arc narrower than two turns meets in the middle', () => {
  assert.equal(turnWidth(arcPath(0, 20, 100, 30), 0), 10);
});

// The band under the words, for the enhanced graph's extra edges.
test('a sentence with no extra edge has no band under its words', () => {
  const { indexById } = sentence(4);
  assert.equal(computeLowerBand([], indexById).bandHeight, 0);
  assert.equal(computeLowerBand(undefined, indexById).bandHeight, 0);
});

test('the band stacks as the tree does and grows with its deepest arc', () => {
  const { indexById } = sentence(5);
  const one = computeLowerBand(arcs([[0, 1]]), indexById);
  const nested = computeLowerBand(
    arcs([
      [0, 3],
      [1, 2],
    ]),
    indexById,
  );
  assert.equal(nested.levels.get('r1'), 1);
  assert.equal(nested.levels.get('r0'), 2);
  assert.equal(nested.bandHeight - one.bandHeight, ARC_STEP);
});

test('an enhanced root is a stub one level deep and takes no level of its own', () => {
  const { indexById } = sentence(3);
  const rootOnly = computeLowerBand([{ id: 'x', source: 's1', target: 's1' }], indexById);
  const oneArc = computeLowerBand(arcs([[0, 1]]), indexById);
  assert.equal(rootOnly.levels.size, 0);
  assert.equal(rootOnly.bandHeight, oneArc.bandHeight);
});

// The arc in the hand, which is drawn as the arc it is about to become.
test('an arc in the hand rises like a landed one and ends at the pointer', () => {
  // Pointer below the innermost level: the full rise, a flat run, a fall to it.
  const low = handArcPath(100, 200, 300, 190);
  assert.ok(
    low.startsWith(`M 100 200 Q 100 ${200 - ARC_BASE} ${100 + ARC_CORNER} ${200 - ARC_BASE}`),
  );
  assert.ok(low.endsWith(`Q 300 ${200 - ARC_BASE} 300 190`));
  // Pointer above it: the arc climbs to the pointer, and leftward mirrors.
  const high = handArcPath(300, 200, 100, 120);
  assert.ok(high.startsWith(`M 300 200 Q 300 120 ${300 - ARC_CORNER} 120`));
  assert.ok(high.endsWith('Q 100 120 100 120'));
});

test('the preview of an arc sits at the level the stacking will give it', () => {
  const spans = [
    { id: 'a', left: 1, right: 2 },
    { id: 'b', left: 0, right: 3 },
  ];
  assert.equal(levelAmong([], 0, 4), 1);
  assert.equal(levelAmong(spans, 3, 4), 1); // beside both
  assert.equal(levelAmong(spans, 0, 2), 2); // over a, under b
  assert.equal(levelAmong(spans, 0, 4), 3); // over both
});

test('under the words an arc in the hand drops where one above would rise', () => {
  const d = handArcPath(100, 200, 300, 260, { down: true });
  assert.ok(d.startsWith(`M 100 200 Q 100 260 ${100 + ARC_CORNER} 260`));
  // A pointer still near the words: out to the innermost level and back to it.
  const near = handArcPath(100, 200, 300, 205, { down: true });
  assert.ok(near.includes(`L ${300 - ARC_CORNER} ${200 + ARC_BASE}`));
  assert.ok(near.endsWith(`Q 300 ${200 + ARC_BASE} 300 205`));
});

// ---------------------------------------------------------------------------
// The annotation editor's geometry: where a word can be grabbed, which word an
// arc in the hand would land on, and the three answers (path, arrowhead,
// label) for an arc above the words and one below them. All of this was inline
// in DependencyTree.jsx, where the only way to check a number was to look at
// the screen.
// ---------------------------------------------------------------------------

// One measured word. `width` is what its reach is proportional to.
const word = (index, x, width = 60) => ({
  token: { id: `w${index}` },
  x,
  y: 120,
  width,
  height: 20,
  index,
});

const FRAME = treeFrame(150); // tokenY 120, baselineY 110

test('the words sit a fixed distance up from the bottom of the overlay', () => {
  assert.equal(FRAME.tokenY, 150 - TOKEN_BASELINE);
  // The arcs spring from above the words, leaving the arrowheads their room.
  assert.ok(FRAME.baselineY < FRAME.tokenY);
  assert.equal(treeFrame(400).tokenY - treeFrame(400).baselineY, FRAME.tokenY - FRAME.baselineY);
});

test('a short word is clickable exactly as far out as it is droppable', () => {
  // The rect that takes the click and the column a drop snaps by are one
  // reach: a two-letter word used to be snappable from further away than it
  // could be grabbed.
  const short = word(0, 100, 10);
  const wide = word(1, 400, 200);
  assert.equal(reachOf(short), 24); // the floor
  assert.equal(reachOf(wide), 120); // the proportion
  // A position measured before its word was has no width yet.
  assert.equal(reachOf({ x: 0 }), 36);

  for (const p of [short, wide]) {
    const rect = grabRect(p);
    assert.equal(rect.x, p.x - reachOf(p));
    assert.equal(rect.x + rect.width, p.x + reachOf(p));
    assert.equal(wordInColumn([p], { x: rect.x + 0.5, y: p.y }, { below: false, frame: FRAME }), p);
    assert.equal(
      wordInColumn([p], { x: rect.x - 1, y: p.y }, { below: false, frame: FRAME }),
      null,
    );
  }
});

test('the nearest word wins where two short ones overlap', () => {
  const a = word(0, 100, 10);
  const b = word(1, 140, 10);
  const at = (x) => wordInColumn([a, b], { x, y: FRAME.tokenY }, { below: false, frame: FRAME });
  // 118 and 122 are inside both reaches (24 each); the nearer takes it.
  assert.equal(at(118), a);
  assert.equal(at(122), b);
  assert.equal(at(70), null); // outside both
});

test('an arc snaps to a word on its own side of them and nowhere else', () => {
  const w = word(0, 100);
  const above = (y) => wordInColumn([w], { x: 100, y }, { below: false, frame: FRAME });
  const below = (y) => wordInColumn([w], { x: 100, y }, { below: true, frame: FRAME });

  // The tree reaches from under the ROOT bar down to just past the words.
  assert.equal(above(ROOT_Y + ROOT_BAR_HEIGHT), w);
  assert.equal(above(ROOT_Y + 1), null); // on the bar: that is the bar's own
  assert.equal(above(FRAME.tokenY + 28), w);
  assert.equal(above(FRAME.tokenY + 29), null);

  // The band reaches from the words down as far as the hand goes, so an
  // enhanced edge is no fussier to draw than a tree one.
  assert.equal(below(FRAME.tokenY - 12), w);
  assert.equal(below(FRAME.tokenY - 13), null);
  assert.equal(below(4000), w);

  assert.equal(wordInColumn([w], null, { frame: FRAME }), null);
});

test('an arrowhead is one triangle, pointed whichever way its arc arrives', () => {
  assert.equal(arrowPoints(100, 50), '97,45 103,45 100,50');
  assert.equal(arrowPoints(100, 50, { up: true }), '97,55 103,55 100,50');
});

test('an arc of the tree leaves its head a few pixels along, either way', () => {
  const right = treeArc({ fromX: 100, toX: 300, height: arcHeight(1), frame: FRAME });
  const left = treeArc({ fromX: 300, toX: 100, height: arcHeight(1), frame: FRAME });
  assert.ok(right.d.startsWith('M 105 110'));
  assert.ok(left.d.startsWith('M 295 110'));
  // Both end on the word they point at, on the arcs' own baseline.
  assert.ok(right.d.endsWith('300 110'));
  assert.ok(left.d.endsWith('100 110'));
  // The label rides above the flat run, midway between the two words.
  assert.deepEqual(right.label, { x: 200, y: FRAME.baselineY - arcHeight(1) - 5 });
  assert.deepEqual(left.label, right.label);
  // The arrowhead is at the DEPENDENT, pointing down onto it.
  assert.equal(right.arrow, arrowPoints(300, FRAME.baselineY + 2));
  assert.equal(left.arrow, arrowPoints(100, FRAME.baselineY + 2));
});

test('a root is a straight drop from the ROOT bar onto its word', () => {
  const root = treeArc({ fromX: 100, toRoot: true, frame: FRAME });
  assert.equal(root.d, `M 100 ${FRAME.baselineY} L 100 ${ROOT_LINE}`);
  assert.equal(root.arrow, arrowPoints(100, FRAME.baselineY + 2));
  // Its label rides halfway down the drop.
  assert.deepEqual(root.label, { x: 100, y: (FRAME.tokenY + ROOT_Y) / 2 });
});

test('an arc of the band below the words is the tree arc turned over', () => {
  const height = arcHeight(2);
  const above = treeArc({ fromX: 100, toX: 300, height, frame: FRAME });
  const below = bandArc({ fromX: 100, toX: 300, height });

  // Same rise out of the head, same fall onto the dependent, mirrored.
  assert.ok(below.d.startsWith(`M 105 ${LOWER_BAND_TOP}`));
  assert.ok(below.d.endsWith(`300 ${LOWER_BAND_TOP}`));
  assert.ok(below.d.includes(`${LOWER_BAND_TOP + height}`));
  assert.ok(above.d.includes(`${FRAME.baselineY - height}`));
  // The arrowhead points UP into the word; the label hangs UNDER the run.
  assert.equal(below.arrow, arrowPoints(300, LOWER_BAND_TOP - 5, { up: true }));
  assert.equal(below.label.x, above.label.x);
  assert.ok(below.label.y > LOWER_BAND_TOP + height);

  // An enhanced root is a stub under its own word.
  const root = bandArc({ fromX: 100, toRoot: true, height: ARC_BASE });
  assert.equal(root.d, `M 100 ${LOWER_BAND_TOP} l 0 ${ARC_BASE}`);
  assert.equal(root.label.x, 100);

  // An arc still in the hand hangs from the measured underside of a word
  // rather than from the band's own top.
  assert.ok(bandArc({ fromX: 100, toX: 300, height, baseline: 90 }).d.startsWith('M 105 90'));
});

test('the overlay is as wide as its last word plus room for that word arc', () => {
  assert.equal(svgWidth([word(0, 100), word(1, 400)]), 450);
  assert.equal(svgWidth([]), 300);
});

test('the labels are walked left to right, a root over its own word', () => {
  const xOf = (id) => ({ s0: 100, s1: 200, s2: 300 })[id];
  const rels = [
    { id: 'far', source: 's0', target: 's2' }, // label at 200
    { id: 'root', source: 's0', target: 's0' }, // label at 100
    { id: 'near', source: 's1', target: 's2' }, // label at 250
  ];
  assert.equal(labelXOf(rels[1], xOf), 100);
  assert.equal(labelXOf(rels[0], xOf), 200);
  assert.deepEqual(
    sortByLabelX(rels, xOf).map((r) => r.id),
    ['root', 'far', 'near'],
  );
  // An endpoint with no measured word yet counts as 0 rather than throwing.
  assert.equal(labelXOf({ source: 'gone', target: 'gone' }, xOf), 0);
});

// The arc in the hand. What matters is that it is already the arc it will be.
test('over a word, the preview IS the arc that is about to land', () => {
  const from = word(0, 100);
  const to = word(2, 300);
  const pointer = { x: 302, y: 104 };
  const nested = [{ id: 'inner', left: 0, right: 2 }];

  assert.deepEqual(
    dragPreview({ from, to, pointer, spans: [], frame: FRAME }),
    treeArc({ fromX: 100, toX: 300, height: arcHeight(1), frame: FRAME }),
  );
  // With an arc already under it, the preview is drawn a level higher, which
  // is where it will sit once it lands.
  assert.deepEqual(
    dragPreview({ from, to, pointer, spans: nested, frame: FRAME }),
    treeArc({ fromX: 100, toX: 300, height: arcHeight(2), frame: FRAME }),
  );
  // Below, the same, hung from the measured underside of the word.
  const under = () => 90;
  assert.deepEqual(
    dragPreview({ from, to, pointer, below: true, spans: [], frame: FRAME, under }),
    bandArc({ fromX: 100, toX: 300, height: arcHeight(1), baseline: 90 }),
  );
});

test('a preview aimed at the ROOT bar is the root drop, above or below', () => {
  const w = word(1, 200);
  // Out of a word and up to the bar: the tree's drop onto that word.
  assert.deepEqual(
    dragPreview({ from: w, to: null, pointer: { x: 200, y: 20 }, toRoot: true, frame: FRAME }),
    treeArc({ fromX: 200, toRoot: true, frame: FRAME }),
  );
  // Out of the bar and onto a word: the same drop.
  assert.deepEqual(
    dragPreview({ from: null, to: w, pointer: { x: 200, y: 90 }, frame: FRAME }),
    treeArc({ fromX: 200, toRoot: true, frame: FRAME }),
  );
  // In the enhanced graph a root is a stub under the word, not a drop from
  // above: the ROOT bar is the tree's, and the band never reaches it.
  assert.deepEqual(
    dragPreview({
      from: w,
      to: null,
      pointer: { x: 200, y: 300 },
      toRoot: true,
      below: true,
      frame: FRAME,
      under: () => 90,
    }),
    bandArc({ fromX: 200, toRoot: true, height: ARC_BASE, baseline: 90 }),
  );
});

test('between words the preview follows the hand and wears no label', () => {
  const from = word(0, 100);

  // Above: it never crosses down through the row of words.
  const high = dragPreview({ from, to: null, pointer: { x: 250, y: 60 }, frame: FRAME });
  assert.equal(high.label, null);
  assert.equal(high.d, handArcPath(100, FRAME.baselineY, 250, 60));
  const past = dragPreview({ from, to: null, pointer: { x: 250, y: 500 }, frame: FRAME });
  assert.equal(past.d, handArcPath(100, FRAME.baselineY, 250, FRAME.baselineY));
  assert.equal(past.arrow, arrowPoints(250, FRAME.baselineY + 2));

  // Below: likewise, it never rises back through them.
  const under = () => 90;
  const low = dragPreview({
    from,
    to: null,
    pointer: { x: 250, y: 300 },
    below: true,
    frame: FRAME,
    under,
  });
  assert.equal(low.label, null);
  assert.equal(low.d, handArcPath(100, 90, 250, 300, { down: true }));
  assert.equal(low.arrow, arrowPoints(250, 295, { up: true }));
  const risen = dragPreview({
    from,
    to: null,
    pointer: { x: 250, y: 10 },
    below: true,
    frame: FRAME,
    under,
  });
  assert.equal(risen.d, handArcPath(100, 90, 250, 90, { down: true }));
});

test('out of the ROOT bar and over no word, the preview hangs from the bar', () => {
  const out = dragPreview({ from: null, to: null, pointer: { x: 250, y: 200 }, frame: FRAME });
  assert.equal(out.d, `M 250 ${ROOT_LINE} L 250 200`);
  assert.equal(out.arrow, arrowPoints(250, 200));
  assert.equal(out.label, null);
  // It never climbs above the bar it came out of.
  const up = dragPreview({ from: null, to: null, pointer: { x: 250, y: 0 }, frame: FRAME });
  assert.equal(up.d, `M 250 ${ROOT_LINE} L 250 ${ROOT_GRAB}`);
});
