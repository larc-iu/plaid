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
