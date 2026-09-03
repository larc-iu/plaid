import { describe, it, expect } from 'vitest';
import {
  assignLanes,
  clampResize,
  conflictingPairs,
  mayOverlap,
  rangeProblem,
  timeBounds,
} from './alignmentTimes.js';

const seg = (id, timeBegin, timeEnd, speaker) => ({
  id,
  metadata: speaker ? { timeBegin, timeEnd, speaker } : { timeBegin, timeEnd },
});
// Out of time order on purpose, one voice throughout.
const TOKENS = [seg('c', 6, 8), seg('a', 0, 2), seg('b', 3, 5)];

describe('mayOverlap', () => {
  it('is cross-talk only: two different labelled speakers', () => {
    expect(mayOverlap(seg('x', 0, 1, 'Ana'), seg('y', 0, 1, 'Ben'))).toBe(true);
    expect(mayOverlap(seg('x', 0, 1, 'Ana'), seg('y', 0, 1, 'Ana'))).toBe(false);
    expect(mayOverlap(seg('x', 0, 1, 'Ana'), seg('y', 0, 1))).toBe(false);
    expect(mayOverlap(seg('x', 0, 1), seg('y', 0, 1))).toBe(false);
  });
});

describe('timeBounds', () => {
  it('is hemmed in by the same voice on either side', () => {
    expect(timeBounds(TOKENS, 'b')).toEqual({ floor: 2, ceiling: 6 });
    expect(timeBounds(TOKENS, 'a')).toEqual({ floor: 0, ceiling: 3 });
    expect(timeBounds(TOKENS, 'c')).toEqual({ floor: 5, ceiling: Infinity });
  });

  it('ignores another speaker, who may be talked over', () => {
    const talk = [seg('a', 0, 4, 'Ana'), seg('b', 3, 5, 'Ben'), seg('c', 6, 8, 'Ana')];
    expect(timeBounds(talk, 'b')).toEqual({ floor: 0, ceiling: Infinity });
    expect(timeBounds(talk, 'a')).toEqual({ floor: 0, ceiling: 6 });
  });
});

describe('clampResize', () => {
  it('stops a dragged edge at the neighbour, the recording, and the other edge', () => {
    expect(clampResize(TOKENS, 'b', 'left', 1)).toBe(2);
    expect(clampResize(TOKENS, 'b', 'left', 4.95)).toBe(4.9);
    expect(clampResize(TOKENS, 'b', 'left', 2.5)).toBe(2.5);
    expect(clampResize(TOKENS, 'b', 'right', 7)).toBe(6);
    expect(clampResize(TOKENS, 'b', 'right', 3.01)).toBe(3.1);
    expect(clampResize(TOKENS, 'c', 'right', 30, { duration: 10 })).toBe(10);
    expect(clampResize(TOKENS, 'a', 'left', -3)).toBe(0);
  });

  it('lets an edge cross another speaker', () => {
    const talk = [seg('a', 0, 4, 'Ana'), seg('b', 3, 5, 'Ben')];
    expect(clampResize(talk, 'a', 'right', 4.8)).toBe(4.8);
  });
});

describe('rangeProblem', () => {
  it('names the neighbour, the recording end, or the zero length, else nothing', () => {
    expect(rangeProblem(TOKENS, 'b', 1.5, 5)).toMatch(/^The previous segment ends at 2\./);
    expect(rangeProblem(TOKENS, 'b', 3, 6.5)).toMatch(/^The next segment starts at 6\./);
    expect(rangeProblem(TOKENS, 'c', 6, 11, { duration: 10 })).toBe('The recording ends at 10.');
    expect(rangeProblem(TOKENS, 'b', 4, 4)).toBe('A segment must end after it starts.');
    expect(rangeProblem(TOKENS, 'b', 2, 6)).toBeNull(); // touching a neighbour is fine
    expect(rangeProblem(TOKENS, 'b', 2.5, 4, { format: (s) => `${s}s` })).toBeNull();
  });

  it('allows cross-talk', () => {
    const talk = [seg('a', 0, 4, 'Ana'), seg('b', 3, 5, 'Ben')];
    expect(rangeProblem(talk, 'b', 1, 5)).toBeNull();
  });
});

describe('conflictingPairs', () => {
  it('lists same-voice and unlabelled overlaps, not cross-talk', () => {
    expect(conflictingPairs(TOKENS)).toEqual([]);
    const bad = [seg('a', 0, 4), seg('b', 3, 5), seg('c', 5, 8)];
    expect(conflictingPairs(bad).map(([x, y]) => [x.id, y.id])).toEqual([['a', 'b']]);
    const talk = [seg('a', 0, 4, 'Ana'), seg('b', 3, 5, 'Ben'), seg('c', 4.5, 6, 'Ben')];
    expect(conflictingPairs(talk).map(([x, y]) => [x.id, y.id])).toEqual([['b', 'c']]);
  });
});

describe('assignLanes', () => {
  it('stacks overlapping segments and reuses a lane once it is free', () => {
    const talk = [seg('a', 0, 4, 'Ana'), seg('b', 3, 5, 'Ben'), seg('c', 5, 8, 'Ana')];
    const { lanes, count } = assignLanes(talk);
    expect([...lanes.entries()]).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 0],
    ]);
    expect(count).toBe(2);
    expect(assignLanes(TOKENS).count).toBe(1);
  });
});
