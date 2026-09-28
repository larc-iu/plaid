import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  attrValueProblem,
  nfc,
  parsePenman,
  serializePenman,
  treeEdges,
} from '../src/domain/format/penman.js';

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
      assert.match(graph.errors[0].message, /is used twice/);
    });

    test('a reference to a variable that is never defined', () => {
      const graph = parsePenman('(s1a / a :ARG0 s1z)');
      assert.equal(graph.errors.length, 1);
      assert.match(graph.errors[0].message, /Variable 's1z' is not defined\./);
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

// Text mode's reading: a sentence's loose parts follow the root's graph as
// graphs of their own. A file holds one graph, so that stays an error there.
test('several top-level graphs are read only when asked for', () => {
  const text = '(s1a / a :ARG0 s1b)\n\n(s1b / b)\n(s1c / c :mod s1a)';
  const one = parsePenman(text);
  assert.match(one.errors[0].message, /Unexpected content after the topmost closing bracket/);
  const several = parsePenman(text, { several: true });
  assert.deepEqual(several.errors, []);
  assert.equal(several.root, 's1a');
  assert.deepEqual(several.tops, ['s1a', 's1b', 's1c']);
  assert.deepEqual([...several.nodes.keys()], ['s1a', 's1b', 's1c']);
  // Junk between graphs is still junk.
  assert.ok(parsePenman('(s1a / a) junk (s1b / b)', { several: true }).errors.length);
});

// validate.py reads `23:45` as a number (validate.py:393), and the guidelines
// write `:time 15:30`. A concept still stops at the colon.
describe('a time as a value', () => {
  test('`:time 15:30` is read as one atom and written back', () => {
    const graph = parsePenman('(s8a / date-entity :time 15:30)');
    assert.deepEqual(graph.errors, []);
    assert.deepEqual(child(graph, 's8a', 0), { rel: ':time', kind: 'atom', value: '15:30' });
    assert.equal(serializePenman(graph), '(s8a / date-entity\n    :time 15:30)');
  });

  test('the next relation after a time is still a relation', () => {
    const graph = parsePenman('(s8a / date-entity :time 15:30 :mod (s8b / thing))');
    assert.deepEqual(graph.errors, []);
    assert.deepEqual(
      graph.nodes.get('s8a').children.map((c) => [c.rel, c.value]),
      [
        [':time', '15:30'],
        [':mod', 's8b'],
      ],
    );
  });

  test('a concept stops at the colon, and so does a value with a second one', () => {
    assert.equal(parsePenman('(s8a / 10:30)').errors.length, 1);
    assert.ok(parsePenman('(s8a / date-entity :time 15:30:00)').errors.length);
  });

  test('the editors take a time as a value and nothing else with a colon', () => {
    assert.equal(attrValueProblem('15:30'), null);
    assert.match(attrValueProblem('15:30:00'), /colons/);
    assert.match(attrValueProblem('a:b'), /colons/);
    assert.match(attrValueProblem(':30'), /colons/);
  });
});

describe('text in NFC', () => {
  const decomposed = 'cafe\u0301';

  test('nfc composes a letter and its combining accent, and leaves the rest alone', () => {
    assert.equal(nfc(decomposed), 'caf\u00e9');
    assert.equal(nfc('caf\u00e9'), 'caf\u00e9');
    assert.equal(nfc(null), null);
    assert.equal(nfc(3), 3);
  });

  test('a graph typed with combining accents is read as NFC', () => {
    // As typed it read as the variable s6e and a stray accent.
    const graph = parsePenman(`(s6${'e\u0301'} / ${decomposed} :mod "${decomposed}")`);
    assert.deepEqual(graph.errors, []);
    assert.equal(graph.root, 's6\u00e9');
    assert.equal(graph.nodes.get('s6\u00e9').concept, 'caf\u00e9');
    assert.equal(child(graph, 's6\u00e9', 0).value, '"caf\u00e9"');
  });
});

describe('a space that does not look like one', () => {
  test('the message names a no-break space before what it found', () => {
    const graph = parsePenman('(s1x / big\u00a0cat)');
    assert.deepEqual(
      graph.errors.map((e) => e.message),
      ["Expected a relation or a closing bracket, found 'cat)', after a no-break space (U+00A0)."],
    );
  });

  test('an ordinary space is not named', () => {
    const graph = parsePenman('(s1x / big cat)');
    assert.deepEqual(
      graph.errors.map((e) => e.message),
      ["Expected a relation or a closing bracket, found 'cat)'."],
    );
  });

  test('only the space right before what was found is named', () => {
    const graph = parsePenman('(s1x /\u00a0big cat)');
    assert.deepEqual(
      graph.errors.map((e) => e.message),
      ["Expected a relation or a closing bracket, found 'cat)'."],
    );
  });
});
