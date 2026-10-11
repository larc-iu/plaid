// The canvas's provenance marks follow the cross-app ruling: a machine's or a
// contributor's node wears a dashed border in the hue and no fill, and the
// document graph's own colours keep clear of the two provenance hues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CATEGORICAL } from '../../plaid-ui/src/domain/dyes.js';

const css = await readFile(
  fileURLToPath(new URL('../src/components/editor/annotation/canvas.css', import.meta.url)),
  'utf8',
);
const block = (selector) => {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${selector} exists`);
  return css.slice(at, css.indexOf('}', at));
};

test('a machine or contributed node has a dashed border in its hue and no fill', () => {
  for (const [state, token] of [
    ['machine', '--plaid-machine'],
    ['contributed', '--plaid-contributed'],
  ]) {
    const rule = block(`.umr-node--${state}`);
    assert.match(rule, /border-style:\s*dashed/);
    assert.match(rule, new RegExp(`border-color:\\s*var\\(${token}\\)`));
    assert.doesNotMatch(rule, /background|--umr-node-bg|fill/);
  }
});

// The document graph's families take the cloth's dyes (plaid-ui's categorical
// palette), which hold no violet, amber or red. Not the teal, which is the
// primary and lights the selection.
test('the document graph takes its colours from the shared dyes', () => {
  for (const name of ['--umr-doc', '--umr-doc-temporal', '--umr-doc-coref']) {
    const m = css.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
    assert.ok(m, `${name} is a hex colour`);
    assert.ok(CATEGORICAL.includes(m[1].toLowerCase()), `${name} ${m[1]} is one of the dyes`);
    assert.notEqual(m[1].toLowerCase(), '#2a5c57', `${name} is not the primary's teal`);
  }
});

// One warning colour in every app: plaid-ui's burnt orange, never amber.
test('a canvas warning is the shared warning colour', () => {
  assert.match(css, /--umr-warning:\s*hsl\(var\(--warning\)\)/);
});

// A problem on a drafted node must not repaint the drafted border: red or amber
// there read as a contributor's node, or hid the violet altogether. The problem
// is the corner dot plus a ring outside the border.
test("a problem rings the node and leaves the provenance border's colour alone", () => {
  for (const level of ['warning', 'error']) {
    const rule = block(`.umr-node:has(> .umr-node-mark--${level})`);
    assert.doesNotMatch(rule, /border-color/);
    assert.match(rule, /outline:\s*2px solid/);
  }
  // Hover and focus come first, so the drafted colour holds under both.
  const drafted = css.indexOf('.umr-node.umr-node--machine {');
  assert.ok(drafted > css.indexOf('.umr-node:hover {'));
  assert.ok(drafted > css.indexOf('.umr-node:focus-visible {'));
});

// Focus cannot take a drafted or contributed node's border, which says who made
// it, so it is a solid ring in the focus colour hugging that border. The pale halo alone
// measured 1.3:1 on white, and a problem's ring painted over it. A problem's
// ring steps out past the focus ring.
test('a focused drafted or contributed node wears a solid ring, clear of a problem ring', () => {
  const focus = block(
    '.umr-node.umr-node--machine:is(.umr-node--focused, :focus-visible),\n.umr-node.umr-node--contributed:is(.umr-node--focused, :focus-visible)',
  );
  assert.match(focus, /box-shadow:\s*0 0 0 2px hsl\(var\(--ring\)\)/);
  assert.doesNotMatch(focus, /border-color/);
  const stepped = block('.umr-node:has(> .umr-node-mark):is(.umr-node--focused, :focus-visible)');
  const offset = Number(stepped.match(/outline-offset:\s*(\d+)px/)[1]);
  assert.ok(offset > 3, `the problem ring clears the 3px focus ring (offset ${offset})`);
});
