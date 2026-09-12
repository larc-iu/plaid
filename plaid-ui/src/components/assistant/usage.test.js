import { describe, it, expect } from 'vitest';
import { NEARLY_FULL, fullness, latestUsage, totalSpend, usageLabel, usageTitle } from './usage.js';

const reply = (usage) => ({ kind: 'assistant', text: 'a', ...(usage ? { usage } : {}) });
const ask = { kind: 'user', text: 'q' };

describe('latestUsage', () => {
  it('reads the newest reply, which is the current state of the thread', () => {
    const display = [
      ask,
      reply({ sent: 100, received: 10 }),
      ask,
      reply({ sent: 400, received: 20 }),
    ];
    expect(latestUsage(display)).toEqual({ sent: 400, received: 20 });
  });

  it('skips a newer reply that carries no counts', () => {
    // An error item, or a reply from a provider that reported nothing. The
    // last figure we actually have still describes the thread better than none.
    const display = [reply({ sent: 100, received: 10 }), { kind: 'error', text: 'x' }, reply(null)];
    expect(latestUsage(display)).toEqual({ sent: 100, received: 10 });
  });

  it('is null for a conversation with no counts at all', () => {
    expect(latestUsage([ask, reply(null)])).toBeNull();
    expect(latestUsage([])).toBeNull();
    expect(latestUsage(undefined)).toBeNull();
  });
});

describe('totalSpend', () => {
  it('adds every turn, because each turn re-sends the whole thread', () => {
    const display = [
      ask,
      reply({ sent: 100, received: 10 }),
      ask,
      reply({ sent: 400, received: 20 }),
    ];
    expect(totalSpend(display)).toBe(530);
  });

  it('counts a reply from before usage was recorded as nothing, not as a gap', () => {
    expect(totalSpend([reply(null), reply({ sent: 50, received: 5 })])).toBe(55);
  });
});

describe('fullness', () => {
  it('is the last turn against the window', () => {
    expect(fullness({ sent: 5000, window: 10000 })).toBe(0.5);
  });

  it('is null without a window, so no caller can render a made-up percentage', () => {
    expect(fullness({ sent: 5000 })).toBeNull();
    expect(fullness({ sent: 5000, window: 0 })).toBeNull();
    expect(fullness(null)).toBeNull();
  });

  it('clamps, so a meter never reports a disagreement as a full thread', () => {
    // The provider counts the prompt and litellm supplies the window. They can
    // differ by a little, and 103% would be saying something about that rather
    // than about the conversation.
    expect(fullness({ sent: 10300, window: 10000 })).toBe(1);
  });
});

describe('usageLabel', () => {
  it('is a percentage when the window is known', () => {
    expect(usageLabel({ sent: 4200, window: 10000 })).toBe('42%');
  });

  it('falls back to the count when the window is not known', () => {
    // Worth seeing even without a denominator: it still grows visibly.
    expect(usageLabel({ sent: 42000 })).toBe('42k');
    expect(usageLabel({ sent: 4200 })).toBe('4.2k');
  });

  it('is null when there is nothing to show', () => {
    expect(usageLabel(null)).toBeNull();
    expect(usageLabel({})).toBeNull();
  });
});

describe('usageTitle', () => {
  it('gives the counts behind the percentage and the conversation total', () => {
    const title = usageTitle({ sent: 42100, received: 900, window: 110000 }, 61000);
    expect(title).toContain('42,100 of 110,000 tokens sent on the last turn.');
    expect(title).toContain('61,000 tokens over the whole conversation.');
  });

  it('says the limit is unknown rather than leaving it implied', () => {
    expect(usageTitle({ sent: 42100, received: 900 }, 43000)).toContain(
      "This model's limit is not known.",
    );
  });

  it('is null with no usage', () => {
    expect(usageTitle(null, 0)).toBeNull();
  });
});

describe('NEARLY_FULL', () => {
  it('leaves room for at least one more turn', () => {
    // The threshold has to fire while another turn can still run, or the note
    // arrives after the failure it exists to prevent.
    expect(NEARLY_FULL).toBeGreaterThan(0.5);
    expect(NEARLY_FULL).toBeLessThan(1);
  });
});
