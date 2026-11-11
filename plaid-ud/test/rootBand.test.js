// The band across the top of the tree, which a root's arc is drawn from: the
// only way to mark a root, so it shows a faint grey at rest and a darker one
// under the pointer. On the page's own colour it could only be found by
// hovering over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(
  new URL('../src/components/editor/annotation/DependencyTree.css', import.meta.url),
  'utf8',
);

// The declarations of the rule whose selector list is exactly `selector`.
const ruleFor = (selector) => {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const hit = rules.find(
    ([, sel]) =>
      sel
        .split(',')
        .map((s) => s.trim())
        .join(',') === selector,
  );
  assert.ok(hit, `no rule for ${selector}`);
  return hit[2];
};
const fillOf = (selector) => /fill:\s*([^;]+);/.exec(ruleFor(selector))?.[1].trim();

test('the root band is faintly grey at rest, never the page colour', () => {
  const resting = fillOf('.tree-root-rect,.tree-root-rect--default');
  assert.equal(resting, 'hsl(var(--muted) / 0.4)');
});

test('the root band darkens under the pointer', () => {
  assert.equal(fillOf('.tree-root-rect--hovered'), 'hsl(var(--muted))');
});
