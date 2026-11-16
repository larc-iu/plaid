import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';

// The homonym note under the popover's "+ Create" row says the form already
// exists in this lexicon. A plain fact, in the popover's hint colour as its
// other hint lines: a warm colour means something is broken.

const css = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'igt-editor.css'),
  'utf8',
);

const rule = (selector) => {
  const re = /([^{}]+)\{([^}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim() === selector) return m[2];
  }
  return null;
};

it('draws the homonym note in the hint colour, not the warning one', () => {
  const note = rule('.igt-vocab-pop__note');
  expect(note).toContain('color: var(--igt-hint)');
  expect(note).not.toContain('warning');
  expect(rule('.igt-vocab-pop__hintline')).toContain('color: var(--igt-hint)');
});
