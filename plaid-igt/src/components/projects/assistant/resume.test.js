import { describe, it, expect } from 'vitest';
import { applyingIndex, rewindForRetry, unansweredTurn } from './resume.js';

const conv = (messages, display) => ({ id: 'c1', messages, display });

describe('unansweredTurn', () => {
  it('is true when nothing came back after the user spoke', () => {
    expect(
      unansweredTurn(conv([{ role: 'user', content: 'hi' }], [{ kind: 'user', text: 'hi' }])),
    ).toBe(true);
  });

  it('is false once the assistant answered, or failed', () => {
    const answered = conv(
      [],
      [
        { kind: 'user', text: 'hi' },
        { kind: 'assistant', text: 'yes' },
      ],
    );
    const failed = conv(
      [],
      [
        { kind: 'user', text: 'hi' },
        { kind: 'error', text: 'boom' },
      ],
    );
    expect(unansweredTurn(answered)).toBe(false);
    expect(unansweredTurn(failed)).toBe(false);
  });

  it('is false for an empty or missing conversation', () => {
    expect(unansweredTurn(conv([], []))).toBe(false);
    expect(unansweredTurn(null)).toBe(false);
  });
});

describe('applyingIndex', () => {
  it('finds the plan left mid-apply', () => {
    const c = conv(
      [],
      [
        { kind: 'user', text: 'do it' },
        { kind: 'assistant', plan: { id: 'p1' }, status: 'applying' },
      ],
    );
    expect(applyingIndex(c)).toBe(1);
  });

  it('is -1 for settled or undecided plans, and for no conversation', () => {
    const settled = conv([], [{ kind: 'assistant', plan: { id: 'p1' }, status: 'applied' }]);
    const undecided = conv([], [{ kind: 'assistant', plan: { id: 'p1' }, status: null }]);
    expect(applyingIndex(settled)).toBe(-1);
    expect(applyingIndex(undecided)).toBe(-1);
    expect(applyingIndex(null)).toBe(-1);
  });
});

describe('rewindForRetry', () => {
  it('drops the user message from an interrupted turn, so sending it again does not duplicate it', () => {
    const c = conv(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
      [
        { kind: 'user', text: 'first' },
        { kind: 'assistant', text: 'ok' },
        { kind: 'user', text: 'second' },
      ],
    );
    const out = rewindForRetry(c);
    expect(out.text).toBe('second');
    expect(out.conv.messages).toHaveLength(2);
    expect(out.conv.display).toHaveLength(2);
    expect(out.conv.id).toBe('c1');
  });

  it('leaves the transcript alone for a failed turn, whose user message was already dropped', () => {
    const c = conv(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
      ],
      [
        { kind: 'user', text: 'first' },
        { kind: 'assistant', text: 'ok' },
        { kind: 'user', text: 'second' },
        { kind: 'error', text: 'the assistant could not answer' },
      ],
    );
    const out = rewindForRetry(c);
    expect(out.text).toBe('second');
    expect(out.conv.messages).toHaveLength(2);
    // Both the user's item and the error go, so the retry rebuilds them.
    expect(out.conv.display).toEqual(c.display.slice(0, 2));
  });

  it('handles a first turn that failed, leaving an empty transcript', () => {
    const c = conv(
      [],
      [
        { kind: 'user', text: 'hi' },
        { kind: 'error', text: 'boom' },
      ],
    );
    const out = rewindForRetry(c);
    expect(out.text).toBe('hi');
    expect(out.conv.messages).toEqual([]);
    expect(out.conv.display).toEqual([]);
  });

  it('returns null when there is nothing the user said to retry', () => {
    expect(rewindForRetry(conv([], []))).toBe(null);
    expect(rewindForRetry(null)).toBe(null);
  });
});
