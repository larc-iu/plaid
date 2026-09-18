import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePenman, serializePenman, treeEdges } from '../src/domain/format/penman.js';

const child = (graph, variable, index) => graph.nodes.get(variable).children[index];

describe('parsePenman', () => {
  test('reads a node, its concept and its children', () => {
    const graph = parsePenman('(s1l / leave-02 :aspect performance :ARG1 (s1p / person))');
    assert.equal(graph.errors.length, 0);
    assert.equal(graph.root, 's1l');
    assert.equal(graph.nodes.get('s1l').concept, 'leave-02');
    assert.deepEqual(child(graph, 's1l', 0), {
      rel: ':aspect',
      kind: 'atom',
      value: 'performance',
    });
    assert.deepEqual(child(graph, 's1l', 1), {
      rel: ':ARG1',
      kind: 'node',
      value: 's1p',
      inline: true,
    });
  });

  test('a re-entrant mention is a node reference, not an atom', () => {
    const graph = parsePenman('(s1w / want-01 :ARG0 (s1b / boy) :ARG1 (s1g / go-01 :ARG0 s1b))');
    assert.equal(graph.errors.length, 0);
    assert.deepEqual(child(graph, 's1g', 0), {
      rel: ':ARG0',
      kind: 'node',
      value: 's1b',
      inline: false,
    });
  });

  test('a forward reference is still a node reference', () => {
    const graph = parsePenman('(s1w / want-01 :ARG0 s1b :ARG1 (s1b / boy))');
    assert.equal(graph.errors.length, 0);
    assert.equal(child(graph, 's1w', 0).kind, 'node');
    assert.equal(child(graph, 's1w', 0).inline, false);
  });

  test('strings keep their quotes and may hold spaces and escaped quotes', () => {
    const graph = parsePenman('(s1n / name :op1 "New York" :op2 "say \\"hi\\"")');
    assert.equal(graph.errors.length, 0);
    assert.deepEqual(child(graph, 's1n', 0), { rel: ':op1', kind: 'string', value: '"New York"' });
    assert.deepEqual(child(graph, 's1n', 1), {
      rel: ':op2',
      kind: 'string',
      value: '"say \\"hi\\""',
    });
  });

  test('atoms cover polarity, numbers and ordinals', () => {
    const graph = parsePenman('(s1p / person :polarity - :quant 1500 :refer-person 3rd :polite +)');
    assert.deepEqual(
      graph.nodes.get('s1p').children.map((c) => [c.kind, c.value]),
      [
        ['atom', '-'],
        ['atom', '1500'],
        ['atom', '3rd'],
        ['atom', '+'],
      ],
    );
  });

  test('a concept may be non-Latin', () => {
    const graph = parsePenman('(s1x35 / 生活-01 :aspect state)');
    assert.equal(graph.errors.length, 0);
    assert.equal(graph.nodes.get('s1x35').concept, '生活-01');
  });

  test('a hash starts a comment outside a string but not inside one', () => {
    const graph = parsePenman('(s1n / name # a note\n  :op1 "a # b")');
    assert.equal(graph.errors.length, 0);
    assert.equal(child(graph, 's1n', 0).value, '"a # b"');
  });

  test('a variable written against the slash is still read', () => {
    const graph = parsePenman('(s6t/ thing)');
    assert.equal(graph.errors.length, 0);
    assert.equal(graph.nodes.get('s6t').concept, 'thing');
  });

  describe('errors', () => {
    test('an unbalanced opening bracket', () => {
      const graph = parsePenman('(s1a / a :ARG0 (s1b / b)');
      assert.equal(graph.errors.length, 1);
      assert.match(graph.errors[0].message, /without closing node 's1a'/);
    });

    test('content after the topmost closing bracket', () => {
      const graph = parsePenman('(s1a / a) :ARG0 (s1b / b)');
      assert.equal(graph.errors.length, 1);
      assert.match(graph.errors[0].message, /after the topmost closing bracket/);
    });

    test('a node without a slash', () => {
      const graph = parsePenman('(s1a b)');
      assert.equal(graph.errors.length, 1);
      assert.match(graph.errors[0].message, /Expected slash and concept/);
    });

    test('a duplicate variable definition', () => {
      const graph = parsePenman('(s1a / a :ARG0 (s1a / b))');
      assert.equal(graph.errors.length, 1);
      assert.match(graph.errors[0].message, /is not unique/);
    });

    test('a reference to a variable that is never defined', () => {
      const graph = parsePenman('(s1a / a :ARG0 s1z)');
      assert.equal(graph.errors.length, 1);
      assert.match(graph.errors[0].message, /'s1z' is unknown/);
      assert.equal(child(graph, 's1a', 0).kind, 'node');
    });

    test('empty text is not an error', () => {
      const graph = parsePenman('   \n  ');
      assert.deepEqual(graph.errors, []);
      assert.equal(graph.root, null);
    });

    test('junk in place of a graph never throws', () => {
      for (const text of ['))(((', ':ARG0 x', '(', '"', '(s1a / a :', '(/ )']) {
        assert.doesNotThrow(() => parsePenman(text));
      }
    });
  });
});

describe('treeEdges', () => {
  test('assigns each node to the first edge a depth-first walk reaches', () => {
    // s1b is reached first under :ARG0, so that is where it is written out.
    const graph = parsePenman('(s1w / want-01 :ARG0 (s1b / boy) :ARG1 (s1g / go-01 :ARG0 s1b))');
    assert.deepEqual([...treeEdges(graph)].sort(), [
      ['s1w', 0],
      ['s1w', 1],
    ]);
  });

  test('descends before moving to the next sibling', () => {
    // A plain sibling-first walk would put s1c under the root; a depth-first
    // one finds it under s1a.
    const graph = parsePenman('(s1r / r :op1 (s1a / a :op1 (s1c / c)) :op2 s1c)');
    assert.deepEqual([...treeEdges(graph)].sort(), [
      ['s1a', 0],
      ['s1r', 0],
    ]);
  });
});

describe('serializePenman', () => {
  const sample = `(s1l / leave-02
    :ARG0 (s1p / person
        :name (s1n / name
            :op1 "Lindsay"))
    :aspect performance
    :purpose (s1e / eat-01
        :ARG0 s1p
        :ARG1 (s1l2 / lunch)
        :aspect performance))`;

  test('writes the canonical shape', () => {
    assert.equal(serializePenman(parsePenman(sample)), sample);
  });

  test('round-trips through the parser', () => {
    const once = serializePenman(parsePenman(sample));
    assert.equal(serializePenman(parsePenman(once)), once);
  });

  test('a graph with no inline markers expands at the first-visit edge', () => {
    const nodes = new Map([
      [
        's1w',
        {
          var: 's1w',
          concept: 'want-01',
          children: [
            { rel: ':ARG0', kind: 'node', value: 's1b', inline: false },
            { rel: ':ARG1', kind: 'node', value: 's1g', inline: false },
          ],
        },
      ],
      ['s1b', { var: 's1b', concept: 'boy', children: [] }],
      [
        's1g',
        {
          var: 's1g',
          concept: 'go-01',
          children: [{ rel: ':ARG0', kind: 'node', value: 's1b', inline: false }],
        },
      ],
    ]);
    assert.equal(
      serializePenman({ root: 's1w', nodes }),
      '(s1w / want-01\n    :ARG0 (s1b / boy)\n    :ARG1 (s1g / go-01\n        :ARG0 s1b))',
    );
  });

  test('an empty graph writes nothing', () => {
    assert.equal(serializePenman({ root: null, nodes: new Map() }), '');
  });
});
