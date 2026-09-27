// The canvas's provenance marks follow the cross-app ruling: a machine's or a
// contributor's node wears a dashed border in the hue and no fill, and the
// document graph's own colours keep clear of the two provenance hues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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

test('the document graph uses no violet and no amber', () => {
  // Violet and magenta sit around 250 to 330 degrees, amber around 25 to 50.
  for (const name of ['--umr-doc', '--umr-doc-temporal', '--umr-doc-coref']) {
    const m = css.match(new RegExp(`${name}:\\s*hsl\\((\\d+)`));
    assert.ok(m, `${name} is an hsl colour`);
    const hue = Number(m[1]);
    assert.ok(!(hue >= 250 && hue <= 330), `${name} hue ${hue} is not violet`);
    assert.ok(!(hue >= 25 && hue <= 50), `${name} hue ${hue} is not amber`);
  }
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
// it, so it is a solid blue ring hugging that border. The pale halo alone
// measured 1.3:1 on white, and a problem's ring painted over it. A problem's
// ring steps out past the focus ring.
test('a focused drafted or contributed node wears a solid ring, clear of a problem ring', () => {
  const focus = block(
    '.umr-node.umr-node--machine:is(.umr-node--focused, :focus-visible),\n.umr-node.umr-node--contributed:is(.umr-node--focused, :focus-visible)',
  );
  assert.match(focus, /box-shadow:\s*0 0 0 2px var\(--umr-edge-lit\)/);
  assert.doesNotMatch(focus, /border-color/);
  const stepped = block('.umr-node:has(> .umr-node-mark):is(.umr-node--focused, :focus-visible)');
  const offset = Number(stepped.match(/outline-offset:\s*(\d+)px/)[1]);
  assert.ok(offset > 3, `the problem ring clears the 3px focus ring (offset ${offset})`);
});
