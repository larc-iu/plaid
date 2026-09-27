import { describe, it, expect } from 'vitest';
import { tabTooSoon } from './cellInput.js';

// The throttle is for a HELD Tab, whose auto-repeat outruns the grid. A Tab
// pressed on purpose is never dropped however soon it follows the last one:
// dropping it kept the caret in the cell, so the value typed there was never
// sent (e2e/precedent.spec.js, whose second Tab came 53 ms after its first).
describe('tabTooSoon', () => {
  it('never drops a Tab that was pressed, however soon after the last', () => {
    expect(tabTooSoon({ repeat: false })).toBe(false);
    expect(tabTooSoon({ repeat: false })).toBe(false);
  });

  it('drops the auto-repeat of a held Tab that comes too soon', () => {
    expect(tabTooSoon({ repeat: false })).toBe(false);
    expect(tabTooSoon({ repeat: true })).toBe(true);
  });
});
