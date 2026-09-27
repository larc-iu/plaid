// The grid's provenance marks read as plaid-ui's shared ones: the same
// pattern (italic, DASHED underline, since dotted means an opener in
// plaid-igt) and the same violet, never a hard-coded near-violet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const rowCss = await read('../src/components/editor/annotation/SentenceRow.css');
const uiCss = await read('../../plaid-ui/src/index.css');

// The declarations of the first rule whose selector list contains `selector`.
const rule = (css, selector) => {
  const re = /([^{}]+)\{([^}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selectors = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((s) => s.trim());
    if (selectors.includes(selector)) return m[2];
  }
  return null;
};

test('a machine or contributed cell is italic with a dashed underline, as plaid-ui marks one', () => {
  const cell = rule(rowCss, '.editable-field--machine');
  assert.ok(cell, 'the rule exists');
  assert.match(cell, /font-style:\s*italic/);
  assert.match(cell, /text-decoration-style:\s*dashed/);
  assert.doesNotMatch(cell, /dotted/);
  const shared = rule(uiCss, '.plaid-prov--machine');
  assert.match(shared, /text-decoration-style:\s*dashed/);
  assert.match(rule(uiCss, '.plaid-prov--contributed'), /text-decoration-style:\s*dashed/);
});

test('the grid names no violet of its own', () => {
  assert.doesNotMatch(rowCss, /#7c3aed|#6d28d9/i);
  assert.match(rule(rowCss, '.word-accept'), /background-color:\s*var\(--plaid-machine\)/);
});

test('Accept and Discard wear the shared review pair', () => {
  const accept = uiCss.match(/\.plaid-review\.plaid-review--accept \{([^}]*)\}/)[1];
  assert.match(accept, /color:\s*var\(--plaid-machine\)/);
  assert.doesNotMatch(rowCss, /accept-predictions-btn|discard-predictions-btn/);
});
