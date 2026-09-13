import { describe, it, expect } from 'vitest';
import { ADAPTER_MEMBERS, assertAdapter, missingFromAdapter } from './adapterContract.js';

// The adapter is a plain object with no shape anywhere, so a member never added
// or renamed on one side showed up as a blank, an unlinked plan row, or a crash
// five components down. UD's `textName` was missing for a week and every plan
// card said "the text" instead of naming what it rewrites.

const whole = Object.fromEntries(ADAPTER_MEMBERS.map((k) => [k, 'x']));

describe('assertAdapter', () => {
  it('passes an adapter that answers everything the shared half asks', () => {
    expect(() => assertAdapter(whole)).not.toThrow();
    expect(missingFromAdapter(whole)).toEqual([]);
  });

  it('names every member that is missing, not just the first', () => {
    const { textName, groupOf, ...rest } = whole;
    void textName;
    void groupOf;
    expect(missingFromAdapter(rest)).toEqual(['textName', 'groupOf']);
    expect(() => assertAdapter(rest)).toThrow(/textName, groupOf/);
  });

  it('counts a member that is there but empty as missing', () => {
    // `undefined` is what a rename leaves behind, and `null` is what a
    // half-written adapter has.
    expect(missingFromAdapter({ ...whole, convHref: undefined })).toEqual(['convHref']);
    expect(missingFromAdapter({ ...whole, ExampleCard: null })).toEqual(['ExampleCard']);
  });

  it('allows an adapter to carry more than the contract', () => {
    // Each app builds these out of helpers of its own, and exporting those on
    // the same object is not an error.
    expect(missingFromAdapter({ ...whole, changeHref: 'x', groupOf: 'x' })).toEqual([]);
  });

  it('reports everything for no adapter at all', () => {
    expect(missingFromAdapter(null)).toEqual(ADAPTER_MEMBERS);
    expect(() => assertAdapter(undefined)).toThrow();
  });
});
