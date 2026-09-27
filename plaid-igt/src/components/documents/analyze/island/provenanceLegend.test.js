// The legend's provenance swatches are samples of the cell marks, so each
// draws the underline its cell does: dashed for a machine's and a
// contributor's value (dotted means an opener in this grid), solid for a
// confirmed one. And no status beside the grid wears a provenance hue.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'igt-editor.css'),
  'utf8',
);

// The declarations of the first rule whose selector list is exactly `selector`.
const rule = (selector) => {
  const re = /([^{}]+)\{([^}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selectors = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((s) => s.trim());
    if (selectors.length === 1 && selectors[0] === selector) return m[2];
  }
  throw new Error(`no rule for ${selector}`);
};
const underline = (decls) => {
  const style = decls.match(/border-bottom(?:-style)?:[^;]*\b(dashed|dotted|solid)\b/);
  return style?.[1];
};

describe('the provenance legend', () => {
  it.each(['machine', 'contributed', 'verified'])(
    'draws the %s swatch with the underline its cell has',
    (state) => {
      const cell = underline(rule(`.igt-field--${state}`));
      expect(cell).toBeTruthy();
      expect(underline(rule(`.igt-legend__prov--${state}`))).toBe(cell);
    },
  );

  it('shows saving in no provenance hue', () => {
    expect(rule(".igt-status[data-state='saving']")).not.toMatch(/--igt-(amber|violet)/);
  });
});
