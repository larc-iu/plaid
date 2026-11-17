import { describe, it, expect } from 'vitest';
import { roundSince, thinkingFor } from './roundClock.js';

const ROUND = { n: 2, began: '2026-11-17T10:00:00.000Z', waiting: false };
const turn = (over = {}) => ({ kind: 'turn', round: ROUND, partial: '', stopping: false, ...over });

describe('roundSince', () => {
  it('is when the model call under way began, by the service, whenever the page first hears of it', () => {
    expect(roundSince(turn())).toBe(Date.parse(ROUND.began));
  });

  it('is null while a tool runs, the text streams, the model is waited for, or the turn stops', () => {
    expect(roundSince(turn({ round: null }))).toBeNull();
    expect(roundSince(turn({ partial: 'Three' }))).toBeNull();
    expect(roundSince(turn({ round: { ...ROUND, waiting: true } }))).toBeNull();
    expect(roundSince(turn({ stopping: true }))).toBeNull();
    expect(roundSince(turn({ kind: 'apply' }))).toBeNull();
  });

  it('is null where the service says nothing of the round, or says it in a shape it cannot read', () => {
    expect(roundSince(turn({ round: undefined }))).toBeNull();
    expect(roundSince(turn({ round: { n: 1 } }))).toBeNull();
    expect(roundSince(turn({ round: { n: 1, began: 'soon' } }))).toBeNull();
  });
});

// The service's clock and the browser's may disagree (REV-SVU-R2-1): the start
// is held between the turn's start and when the page first heard of the round.
describe('roundSince across clocks that disagree', () => {
  const STARTED = Date.parse('2026-11-17T09:59:00.000Z');
  const SEEN = Date.parse('2026-11-17T10:00:00.000Z');
  const at = (began) =>
    roundSince(
      turn({
        startedAt: STARTED,
        round: { ...ROUND, began: new Date(began).toISOString() },
        roundSeen: { n: ROUND.n, began: new Date(began).toISOString(), at: SEEN },
      }),
    );

  it('never starts later than the page first heard of the round (the service clock ahead)', () => {
    expect(at(SEEN + 90_000)).toBe(SEEN);
  });

  it('never starts before the turn did (the service clock behind)', () => {
    expect(at(STARTED - 120_000)).toBe(STARTED);
  });

  it('is the service’s start where the two agree', () => {
    expect(at(SEEN - 20_000)).toBe(SEEN - 20_000);
  });
});

describe('thinkingFor', () => {
  it('says seconds, then minutes and seconds', () => {
    expect(thinkingFor(0)).toBe('Thinking, 0 s');
    expect(thinkingFor(45_900)).toBe('Thinking, 45 s');
    expect(thinkingFor(125_000)).toBe('Thinking, 2 min 5 s');
    expect(thinkingFor(-3_000)).toBe('Thinking, 0 s');
  });
});
