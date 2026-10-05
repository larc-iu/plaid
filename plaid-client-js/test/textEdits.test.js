// composeTextEdits, gapsToOps and applyTextOps. The cases in
// fixtures/text-edits.json are shared with the Python client
// (tests/test_text_edits.py) and the core, so the three composers agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { composeTextEdits, gapsToOps, applyTextOps } from '../src/textEdits.js';

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, 'fixtures', 'text-edits.json'), 'utf8'));

for (const c of cases) {
  test(`fixture: ${c.name}`, () => {
    assert.deepEqual(composeTextEdits(c.body, c.ops), c.gaps);
    assert.equal(applyTextOps(c.body, c.ops), c.result);
    assert.equal(applyTextOps(c.body, gapsToOps(c.gaps)), c.result);
  });
}

test('gapsToOps gives an insert, a delete or a replace in running coordinates', () => {
  assert.deepEqual(
    gapsToOps([
      { start: 0, end: 0, value: 'ab' },
      { start: 2, end: 4, value: '' },
      { start: 6, end: 7, value: 'xyz' },
    ]),
    [
      { type: 'insert', index: 0, value: 'ab' },
      { type: 'delete', index: 4, value: 2 },
      { type: 'replace', index: 6, length: 1, value: 'xyz' },
    ],
  );
});

test('a malformed op throws', () => {
  for (const op of [
    null,
    { type: 'insert', index: 0 },
    { type: 'insert', index: 0.5, value: 'a' },
    { type: 'delete', index: 0, value: 'a' },
    { type: 'replace', index: 0, value: 'a' },
    { type: 'move', index: 0, value: 1 },
  ]) {
    assert.throws(() => composeTextEdits('abc', [op]), /Malformed text edit operation/);
    assert.throws(() => applyTextOps('abc', [op]), /Malformed text edit operation/);
  }
});

test('an op out of bounds throws, counting code points', () => {
  for (const op of [
    { type: 'insert', index: 3, value: 'a' },
    { type: 'insert', index: -1, value: 'a' },
    { type: 'delete', index: 1, value: 2 },
    { type: 'delete', index: 0, value: -1 },
    { type: 'replace', index: 2, length: 1, value: 'a' },
  ]) {
    assert.throws(() => composeTextEdits('𐌰𐌱', [op]), /out of bounds.*2 code points/);
  }
  // an op is checked against the body the ops before it left
  assert.throws(
    () =>
      composeTextEdits('ab', [
        { type: 'delete', index: 0, value: 1 },
        { type: 'delete', index: 1, value: 1 },
      ]),
    /out of bounds/,
  );
});

// splitmix32: full period over 2^32 seeds.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ['a', 'b', 'c', ' ', '𐌰', '😀', 'e', '\u0301', '\n'];

function randomText(r, max) {
  const n = Math.floor(r() * max);
  let s = '';
  for (let i = 0; i < n; i += 1) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return s;
}

function randomOps(r, body) {
  const ops = [];
  let len = [...body].length;
  const n = Math.floor(r() * 12);
  for (let i = 0; i < n; i += 1) {
    const kind = r();
    const index = Math.floor(r() * (len + 1));
    if (kind < 0.45) {
      const value = randomText(r, 4);
      ops.push({ type: 'insert', index, value });
      len += [...value].length;
    } else if (kind < 0.8) {
      const value = Math.floor(r() * (len - index + 1));
      ops.push({ type: 'delete', index, value });
      len -= value;
    } else {
      const length = Math.floor(r() * (len - index + 1));
      const value = randomText(r, 4);
      ops.push({ type: 'replace', index, length, value });
      len += [...value].length - length;
    }
  }
  return ops;
}

test('property: composed ops make the same body, gaps are sorted and apart, and composing again is stable', () => {
  const r = rng(20260930);
  for (let run = 0; run < 3000; run += 1) {
    const body = randomText(r, 10);
    const ops = randomOps(r, body);
    const gaps = composeTextEdits(body, ops);
    const composed = gapsToOps(gaps);
    assert.equal(applyTextOps(body, composed), applyTextOps(body, ops), JSON.stringify({ body, ops }));
    const old = [...body];
    gaps.forEach((g, i) => {
      assert.ok(g.start <= g.end && g.end <= old.length, JSON.stringify({ body, ops, gaps }));
      assert.notEqual(g.value, old.slice(g.start, g.end).join(''));
      if (i > 0) assert.ok(gaps[i - 1].end < g.start, JSON.stringify({ body, ops, gaps }));
    });
    assert.deepEqual(composeTextEdits(body, composed), gaps, JSON.stringify({ body, ops }));
  }
});

// A whole text pasted in one run is longer than a spread's argument limit
// (about 120,000 in V8), so the composer must not spread the typed run.
test('a 300,000-character typed run composes into one gap', () => {
  const unit = [...'abcdé𐌰 '];
  const long = Array.from({ length: 300000 }, (_, i) => unit[i % unit.length]).join('');
  assert.deepEqual(composeTextEdits('', [{ type: 'insert', index: 0, value: long }]), [
    { start: 0, end: 0, value: long },
  ]);
  const body = 'old text';
  assert.deepEqual(
    composeTextEdits(body, [
      { type: 'replace', index: 0, length: 8, value: long },
      { type: 'insert', index: 300000, value: '!' },
    ]),
    [{ start: 0, end: 8, value: `${long}!` }],
  );
});
