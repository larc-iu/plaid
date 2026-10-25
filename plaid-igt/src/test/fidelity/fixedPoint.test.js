import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { canonicalExport, diffExports, lineDiff } from '../../../e2e/fidelity/fixedPoint.mjs';

// The fixed point's own machinery (e2e/fidelity/fixedPoint.mjs), which the
// round trips and the prod-copy runs lean on.

const archive = (vocab) => zipSync({ 'vocabularies/Lex.json': strToU8(JSON.stringify(vocab)) });

describe('lineDiff', () => {
  it('numbers the lines that differ as the whole files number them', () => {
    const a = ['h1', 'h2', 'x', 't1', 't2'].join('\n');
    const b = ['h1', 'h2', 'y', 'z', 't1', 't2'].join('\n');
    expect(lineDiff(a, b)).toEqual([
      { side: '+', line: 3, text: 'y' },
      { side: '+', line: 4, text: 'z' },
      { side: '-', line: 3, text: 'x' },
    ]);
    expect(lineDiff(a, a)).toEqual([]);
  });

  // ROUNDTRIP-PROD-2: a large vocabulary file differing in one line took the
  // runner past 22 GB in the quadratic table.
  it('costs a long file differing in one place only that place', () => {
    const lines = Array.from({ length: 200_000 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[100_000] = 'changed';
    expect(lineDiff(lines.join('\n'), changed.join('\n'))).toEqual([
      { side: '+', line: 100_001, text: 'changed' },
      { side: '-', line: 100_001, text: 'line 100000' },
    ]);
  });

  it('prints a difference too wide for the table line by line, without the table', () => {
    const a = Array.from({ length: 5000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 5000 }, (_, i) => `b${i}`).join('\n');
    const out = lineDiff(a, b);
    expect(out).toHaveLength(10_000);
    expect(out[0]).toEqual({ side: '-', line: 1, text: 'a0' });
    expect(out[5000]).toEqual({ side: '+', line: 1, text: 'b0' });
  });
});

describe('canonicalExport heldSlugs', () => {
  const second = archive({ name: 'Lex', config: { dict: { slug: 'lex', title: 'T' } } });
  const third = archive({ name: 'Lex', config: { dict: { title: 'T' } } });

  // ROUNDTRIP-PROD-2: the second import ran on a core where the first import
  // held the address, so it dropped it, rightly.
  it('drops an address the core held when the next import ran', () => {
    expect(
      diffExports(
        canonicalExport(second, 'x', { heldSlugs: new Set(['lex']) }),
        canonicalExport(third),
      ),
    ).toEqual([]);
  });

  it('keeps an address no vocabulary on the core held', () => {
    expect(
      diffExports(
        canonicalExport(second, 'x', { heldSlugs: new Set(['other']) }),
        canonicalExport(third),
      ),
    ).not.toEqual([]);
    expect(diffExports(canonicalExport(second), canonicalExport(third))).not.toEqual([]);
  });

  it('drops the namespace the address was alone in', () => {
    const only = archive({ name: 'Lex', config: { dict: { slug: 'lex' } } });
    const none = archive({ name: 'Lex', config: {} });
    expect(
      diffExports(
        canonicalExport(only, 'x', { heldSlugs: new Set(['lex']) }),
        canonicalExport(none),
      ),
    ).toEqual([]);
  });
});
