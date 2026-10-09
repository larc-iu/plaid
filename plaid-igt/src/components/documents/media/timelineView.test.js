import { beforeEach, describe, expect, it } from 'vitest';
import { readTimelineView, writeTimelineView, TIMELINE_VIEWS_KEPT } from './timelineView.js';

beforeEach(() => localStorage.clear());

describe('the timeline view kept per document', () => {
  it('gives back what was kept for that document, and nothing for another', () => {
    writeTimelineView('d1', { pixelsPerSecond: 80, left: 12.5 });
    expect(readTimelineView('d1')).toEqual({ pixelsPerSecond: 80, left: 12.5 });
    expect(readTimelineView('d2')).toBeNull();
  });

  it('keeps the latest view of a document once', () => {
    writeTimelineView('d1', { pixelsPerSecond: 80, left: 1 });
    writeTimelineView('d1', { pixelsPerSecond: 40, left: 2 });
    expect(readTimelineView('d1')).toEqual({ pixelsPerSecond: 40, left: 2 });
    expect(JSON.parse(localStorage.getItem('plaid_igt_timeline_view'))).toHaveLength(1);
  });

  it('forgets the documents used longest ago past the cap', () => {
    for (let i = 0; i <= TIMELINE_VIEWS_KEPT; i += 1) {
      writeTimelineView(`d${i}`, { pixelsPerSecond: 10, left: i });
    }
    // d1 used again, so it stays when d0 goes.
    writeTimelineView('d1', { pixelsPerSecond: 10, left: 1 });
    expect(readTimelineView('d0')).toBeNull();
    expect(readTimelineView('d1')).toEqual({ pixelsPerSecond: 10, left: 1 });
    expect(readTimelineView(`d${TIMELINE_VIEWS_KEPT}`)).not.toBeNull();
  });

  it('reads nothing from a store it cannot parse or a view that makes no sense', () => {
    localStorage.setItem('plaid_igt_timeline_view', '{not json');
    expect(readTimelineView('d1')).toBeNull();
    localStorage.setItem(
      'plaid_igt_timeline_view',
      JSON.stringify([['d1', { pixelsPerSecond: -3, left: 0 }]]),
    );
    expect(readTimelineView('d1')).toBeNull();
    writeTimelineView('d2', { pixelsPerSecond: 20, left: 0 });
    expect(readTimelineView('d2')).toEqual({ pixelsPerSecond: 20, left: 0 });
  });
});
