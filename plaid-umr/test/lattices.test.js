import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASPECT_LATTICE,
  NUMBER_LATTICE,
  PERSON_LATTICE,
  latticeFor,
  latticeValues,
  linesFor,
  pathTo,
  valuesFor,
} from '../src/domain/lattices.js';
import { ATTRIBUTES } from '../src/domain/format/inventory.js';

// The picker and the validator must agree on what a value is called: every
// schema value has a place in its lattice, and the lattice invents none.
test('the lattices hold exactly the schema values', () => {
  // Spelled the validator's way, non-singular with its hyphen.
  const same = (lattice, rel, extra = []) => {
    const spell = (v) => (v === 'nonsingular' ? 'non-singular' : v);
    const schema = new Set([...ATTRIBUTES[rel].schema.map(spell), ...extra]);
    const held = new Set(latticeValues(lattice));
    assert.deepEqual(
      [...held].filter((v) => !schema.has(v)),
      [],
      `${rel} invents values`,
    );
    assert.deepEqual(
      [...schema].filter((v) => !held.has(v)),
      [],
      `${rel} misses values`,
    );
  };
  same(ASPECT_LATTICE, ':aspect');
  same(PERSON_LATTICE, ':refer-person', ['4th']);
  same(NUMBER_LATTICE, ':refer-number');
});

test('a path runs from the top to a fine value, first appearance for a shared one', () => {
  assert.deepEqual(pathTo(ASPECT_LATTICE, 'reversible-directed-achievement'), [
    'process',
    'perfective',
    'performance',
    'directed-achievement',
    'reversible-directed-achievement',
  ]);
  assert.deepEqual(pathTo(ASPECT_LATTICE, 'atelic-process'), ['imperfective', 'atelic-process']);
  assert.equal(pathTo(ASPECT_LATTICE, 'nope'), null);
});

test('the lines for a value are the top level and the children along its path', () => {
  const lines = linesFor(ASPECT_LATTICE, 'performance');
  assert.deepEqual(
    lines.map((l) => l.on),
    ['process', 'perfective', 'performance', null],
  );
  assert.deepEqual(lines[3].values, [
    'inceptive',
    'incremental-accomplishment',
    'nonincremental-accomplishment',
    'directed-achievement',
  ]);
  // Unset, or a value the lattice does not know: the top level alone.
  assert.deepEqual(
    linesFor(ASPECT_LATTICE, null).map((l) => l.values.length),
    [4],
  );
  assert.deepEqual(linesFor(ASPECT_LATTICE, 'Performance').length, 1);
  // A leaf ends the lines.
  assert.equal(linesFor(ASPECT_LATTICE, 'habitual').length, 1);
});

test('cutting a lattice to a set drops a value and lifts its children', () => {
  const validator = valuesFor(':refer-number');
  assert.ok(!validator.includes('non-dual-paucal'));
  const cut = latticeFor(':refer-number', validator);
  const nonSingular = cut.find((x) => x.value === 'non-singular');
  assert.deepEqual(
    nonSingular.children.map((x) => x.value),
    ['dual', 'paucal', 'plural'],
  );
  assert.deepEqual(
    nonSingular.children.find((x) => x.value === 'paucal').children.map((x) => x.value),
    ['trial'],
  );
  // iterative is schema-only, so the validator set has no line for it.
  assert.ok(!latticeValues(latticeFor(':aspect', valuesFor(':aspect'))).includes('iterative'));
  assert.ok(
    latticeValues(latticeFor(':aspect', valuesFor(':aspect', 'schema'))).includes('iterative'),
  );
  assert.equal(latticeFor(':polarity', ['+', '-']), null);
});

test('an open validator set falls back to the schema list', () => {
  assert.deepEqual(valuesFor(':polarity'), ['-', '-intense', '+']);
  assert.deepEqual(valuesFor(':mode'), ['interrogative', 'imperative', 'expressive']);
  assert.ok(valuesFor(':refer-number', 'schema').includes('non-singular'));
  assert.ok(!valuesFor(':refer-number', 'schema').includes('nonsingular'));
  assert.deepEqual(valuesFor(':quant'), []);
});
