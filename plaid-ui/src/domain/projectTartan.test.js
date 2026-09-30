import { describe, it, expect } from 'vitest';
import { tartanRects } from './projectTartan.js';

// A project's tartan is a function of its id: the same cloth in every app and
// on every visit, a different one for another project, and never a colour the
// annotation surfaces or the product mark keep for themselves.

const A = '01a06937-909e-7112-ba73-2048d989e168';
const B = '01a07d7f-d271-7e7a-b1f5-2a47bf1758b5';
// Two ids made the same second: a UUIDv7 starts with its time.
const C1 = '01a0d40d-fadc-7000-bd35-616ec4b3cbaa';
const C2 = '01a0d40d-fadc-7000-bd35-616ec4b3cbab';

const colors = (id, size) => tartanRects(id, size).map((r) => r.color);

describe('project tartans', () => {
  it('weaves the same cloth for the same id', () => {
    expect(tartanRects(A, 32)).toEqual(tartanRects(A, 32));
    expect(tartanRects(A, 14)).toEqual(tartanRects(A, 14));
  });

  it('weaves different cloth for two projects of one name, and for ids a second apart', () => {
    expect(colors(A, 32)).not.toEqual(colors(B, 32));
    expect(tartanRects(C1, 14)).not.toEqual(tartanRects(C2, 14));
  });

  it('draws only the ground and a few bands when small, the whole sett when larger', () => {
    // The ground, then each band across both axes.
    expect(tartanRects(A, 14).length).toBeLessThanOrEqual(7);
    expect(tartanRects(A, 32).length).toBeGreaterThan(7);
  });

  it('keeps every thread inside the cloth', () => {
    for (const r of tartanRects(A, 32)) {
      expect(r.x).toBeGreaterThanOrEqual(2.5);
      expect(r.y).toBeGreaterThanOrEqual(2.5);
    }
  });

  it('never uses violet, amber or the mark’s oxblood', () => {
    const reserved = ['#6d28d9', '#c4b5fd', '#b45309', '#fcd34d', '#7f1d1d'];
    for (let i = 0; i < 200; i++) {
      const id = `01a0d40d-fadc-7000-bd35-${String(i).padStart(12, '0')}`;
      for (const c of colors(id, 32)) expect(reserved).not.toContain(c);
    }
  });
});

import { showsTartan } from './projectTartan.js';

describe('showsTartan', () => {
  it('shows a loaded project’s tartan unless its settings turned it off', () => {
    expect(showsTartan({ id: 'p1' })).toBe(true);
    expect(showsTartan({ id: 'p1', config: { plaid: { tartan: true } } })).toBe(true);
    expect(showsTartan({ id: 'p1', config: { plaid: { tartan: false } } })).toBe(false);
    expect(showsTartan(null)).toBe(false);
  });
});
