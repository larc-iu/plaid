import { describe, it, expect, afterEach } from 'vitest';
import { PROV, PROV_STATES } from '@larc-iu/plaid-client';
import { anchoredPos, provTitle } from './shared.js';
import { chrome } from './chrome.js';

// Where the grid's floating surfaces sit. All three (the popover, the row menu,
// the alternatives list) share this, so the edges are worth pinning: an edge
// column must not push one off screen, and a short window must not hide it.

const anchor = ({ left = 100, top = 100, width = 40, height = 20 }) => ({
  getBoundingClientRect: () => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  }),
});

const viewport = (w, h) => {
  window.innerWidth = w;
  window.innerHeight = h;
};

afterEach(() => viewport(1024, 768));

describe('anchoredPos', () => {
  it('sits under its opener, left-aligned or centred', () => {
    viewport(1024, 768);
    expect(anchoredPos(anchor({ left: 100, top: 100 }), { width: 240, height: 80 })).toEqual({
      left: 100,
      top: 124,
    });
    expect(
      anchoredPos(anchor({ left: 500, top: 100 }), { width: 240, height: 80, center: true }),
    ).toEqual({ left: 400, top: 124 });
  });

  it('flips above when there is no room below', () => {
    viewport(1024, 300);
    expect(anchoredPos(anchor({ left: 100, top: 200 }), { width: 240, height: 80 })).toEqual({
      left: 100,
      top: 116,
    });
  });

  it('stays on screen when neither side has the room', () => {
    viewport(1024, 120);
    const { top } = anchoredPos(anchor({ left: 100, top: 40 }), { width: 240, height: 100 });
    // As far up as it can go while keeping its bottom edge off the fold.
    expect(top).toBe(12);
  });

  it('keeps an edge column s surface inside the viewport', () => {
    viewport(400, 768);
    const { left } = anchoredPos(anchor({ left: 380, top: 100 }), { width: 240, height: 80 });
    expect(left).toBe(400 - 240 - 8);
  });

  it('is nothing at all without an opener', () => {
    expect(anchoredPos(null, { width: 240, height: 80 })).toBeNull();
  });
});

// "machine-made" names machine output on screen in every app (the owner's
// ruling of 2026-09-28): the legend, igt's tooltips and UMR's alike.
describe('the provenance tooltip', () => {
  it('says machine-made, unverified or confirmed', () => {
    expect(provTitle('kai', PROV_STATES.MACHINE, PROV.INFERRED, false)).toMatch(
      /^kai: machine-made, unverified\. /,
    );
    expect(provTitle('kai', PROV_STATES.VERIFIED, PROV.INFERRED, false)).toBe(
      'kai: machine-made, confirmed',
    );
    expect(provTitle('kai', PROV_STATES.VERIFIED, PROV.CONTRIBUTED, false)).toBe(
      'kai: contributed, confirmed',
    );
  });

  it('names no key to a person who cannot write', () => {
    expect(
      provTitle('kai', PROV_STATES.MACHINE, PROV.INFERRED, false, 'low confidence', true),
    ).toBe('kai: machine-made, unverified, low confidence');
    expect(provTitle('kai', PROV_STATES.CONTRIBUTED, PROV.CONTRIBUTED, false, null, true)).toBe(
      'kai: contributed, unverified',
    );
    expect(provTitle('kai', PROV_STATES.MACHINE, PROV.INFERRED, false)).toMatch(
      / to accept the whole word$/,
    );
  });
});

describe('the tooltip of a link chip', () => {
  const text = (state, canLink, isContributor = false) =>
    chrome._linkStateText.call(
      { doc: { isContributor } },
      state,
      PROV.INFERRED,
      'kai',
      canLink,
      true,
    );

  it('tells a writer what opening the chip does', () => {
    expect(text(PROV_STATES.MACHINE, true)).toBe('Auto-linked to "kai": open to accept or change');
    expect(text(PROV_STATES.CONTRIBUTED, true)).toBe(
      'Linked to "kai": contributed. Open to accept or change',
    );
  });

  it('names the state and no action where the chip does not open', () => {
    expect(text(PROV_STATES.MACHINE, false)).toBe('Auto-linked to "kai", unconfirmed');
    expect(text(PROV_STATES.CONTRIBUTED, false)).toBe('Linked to "kai": contributed, unconfirmed');
    expect(text(PROV_STATES.HUMAN, false)).toBe('Linked to "kai"');
  });
});
