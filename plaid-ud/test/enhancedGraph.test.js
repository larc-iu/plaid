// Pure-fn tests for the enhanced dependency graph (enhancedGraph.js): how the
// graph is read off the basic tree and the enhanced layer's rows, and how a
// DEPS column becomes those rows and comes back out of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  enhancedEdges,
  extraEdges,
  suppressedBasicIds,
  suppressorFor,
  danglingSuppressorIds,
  parseDeps,
  planEnhancedRow,
  serializeDeps,
} from '../src/domain/enhancedGraph.js';

const rel = (id, source, target, value) => ({ id, source, target, value });
const suppressor = (id, source, target) => ({
  id,
  source,
  target,
  value: null,
  metadata: { suppress: true },
});

const summary = (edges) => edges.map((e) => `${e.source}>${e.target}:${e.value}:${e.origin}`);

test('with no rows the enhanced graph is the basic tree', () => {
  const basic = [rel('b1', 's2', 's2', 'root'), rel('b2', 's2', 's1', 'nsubj')];
  assert.deepEqual(summary(enhancedEdges(basic, [])), ['s2>s2:root:basic', 's2>s1:nsubj:basic']);
});

test('an extra edge is added beside the tree, even over the same pair', () => {
  const basic = [rel('b1', 's2', 's1', 'nsubj')];
  const rows = [rel('e1', 's4', 's1', 'nsubj'), rel('e2', 's2', 's1', 'nsubj:xsubj')];
  assert.deepEqual(summary(enhancedEdges(basic, rows)), [
    's2>s1:nsubj:basic',
    's4>s1:nsubj:enhanced',
    's2>s1:nsubj:xsubj:enhanced',
  ]);
});

test('a suppressor removes the basic relation over its pair and nothing else', () => {
  const basic = [rel('b1', 's2', 's1', 'nmod'), rel('b2', 's2', 's3', 'obj')];
  const rows = [suppressor('x1', 's2', 's1'), rel('e1', 's2', 's1', 'nmod:of')];
  assert.deepEqual(summary(enhancedEdges(basic, rows)), [
    's2>s3:obj:basic',
    's2>s1:nmod:of:enhanced',
  ]);
  assert.deepEqual([...suppressedBasicIds(basic, rows)], ['b1']);
  assert.equal(suppressorFor(basic[0], rows).id, 'x1');
  assert.equal(suppressorFor(basic[1], rows), null);
  assert.deepEqual(
    extraEdges(rows).map((r) => r.id),
    ['e1'],
  );
});

test('a suppressed root is a suppressor over the self-loop', () => {
  const basic = [rel('b1', 's1', 's1', 'root')];
  assert.deepEqual(enhancedEdges(basic, [suppressor('x1', 's1', 's1')]), []);
});

test('a suppressor whose basic relation has moved is dangling', () => {
  const rows = [suppressor('x1', 's2', 's1'), rel('e1', 's2', 's1', 'nmod:of')];
  assert.deepEqual(danglingSuppressorIds([rel('b1', 's2', 's1', 'nmod')], rows), []);
  // The head was re-pointed: a delete and a create, so the pair is new.
  assert.deepEqual(danglingSuppressorIds([rel('b9', 's5', 's1', 'nmod')], rows), ['x1']);
  assert.deepEqual(danglingSuppressorIds([], rows), ['x1']);
});

test('parseDeps reads heads and relations, colons and all', () => {
  assert.equal(parseDeps('_'), null);
  assert.equal(parseDeps(''), null);
  assert.deepEqual(parseDeps('2:nsubj|4:nsubj:xsubj'), {
    edges: [
      { head: 2, deprel: 'nsubj' },
      { head: 4, deprel: 'nsubj:xsubj' },
    ],
    emptyHeads: 0,
  });
  assert.deepEqual(parseDeps('0:root'), { edges: [{ head: 0, deprel: 'root' }], emptyHeads: 0 });
  assert.deepEqual(parseDeps('5:obl:in:loc').edges, [{ head: 5, deprel: 'obl:in:loc' }]);
});

test('parseDeps leaves out an edge from an empty node and counts it', () => {
  assert.deepEqual(parseDeps('8.1:nsubj'), { edges: [], emptyHeads: 1 });
  assert.deepEqual(parseDeps('3:conj|8.1:nsubj'), {
    edges: [{ head: 3, deprel: 'conj' }],
    emptyHeads: 1,
  });
});

test('parseDeps drops a repeated edge and refuses a malformed one', () => {
  assert.equal(parseDeps('2:nsubj|2:nsubj').edges.length, 1);
  assert.throws(() => parseDeps('nsubj'), /Invalid DEPS/);
  assert.throws(() => parseDeps('2:'), /Invalid DEPS/);
  assert.throws(() => parseDeps('x:nsubj'), /Invalid DEPS/);
});

test('a row whose DEPS restates its basic relation adds nothing', () => {
  const plan = planEnhancedRow({ head: 2, deprel: 'nsubj' }, parseDeps('2:nsubj'));
  assert.deepEqual(plan, { extras: [], suppress: false });
});

test('a row with a second head keeps its tree and gains an extra', () => {
  const plan = planEnhancedRow({ head: 2, deprel: 'nsubj' }, parseDeps('2:nsubj|4:nsubj'));
  assert.deepEqual(plan, { extras: [{ head: 4, deprel: 'nsubj' }], suppress: false });
});

test('a relabelled row suppresses its basic relation and adds the new label', () => {
  const plan = planEnhancedRow({ head: 2, deprel: 'nmod' }, parseDeps('2:nmod:of'));
  assert.deepEqual(plan, { extras: [{ head: 2, deprel: 'nmod:of' }], suppress: true });
});

test('a row that says nothing, or names only empty nodes, follows its tree', () => {
  assert.deepEqual(planEnhancedRow({ head: 2, deprel: 'orphan' }, null), {
    extras: [],
    suppress: false,
  });
  assert.deepEqual(planEnhancedRow({ head: 2, deprel: 'orphan' }, parseDeps('2.1:nsubj')), {
    extras: [],
    suppress: false,
  });
});

test('a row with no basic relation has nothing to suppress', () => {
  const plan = planEnhancedRow({ head: 0, deprel: null }, parseDeps('3:conj'));
  assert.deepEqual(plan, { extras: [{ head: 3, deprel: 'conj' }], suppress: false });
});

test('serializeDeps orders by head, then by relation', () => {
  assert.equal(serializeDeps([]), '_');
  assert.equal(
    serializeDeps([
      { head: 4, deprel: 'nsubj' },
      { head: 2, deprel: 'nsubj:xsubj' },
      { head: 2, deprel: 'nsubj' },
    ]),
    '2:nsubj|2:nsubj:xsubj|4:nsubj',
  );
  assert.equal(serializeDeps([{ head: 0, deprel: 'root' }]), '0:root');
});
