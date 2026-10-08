import { describe, it, expect } from 'vitest';
import {
  MESSAGE_ROOM,
  NEARLY_FULL,
  fullness,
  gauge,
  gaugeLabel,
  gaugeTitle,
  latestUsage,
  recordBytes,
  recordShare,
  totalSpend,
  usageLabel,
  usageTitle,
} from './usage.js';

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
  it('adds every model call of every turn, not only the last call of each', () => {
    const display = [
      ask,
      reply({ sent: 100, received: 10, total: { sent: 250, received: 30, calls: 3 } }),
      ask,
      reply({ sent: 400, received: 20, total: { sent: 400, received: 20, calls: 1 } }),
    ];
    expect(totalSpend(display)).toBe(700);
  });

  it('counts a reply with no counts as nothing, not as a gap', () => {
    expect(
      totalSpend([reply(null), reply({ sent: 50, received: 5, total: { sent: 50, received: 5 } })]),
    ).toBe(55);
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
    expect(title).toContain(
      "In this conversation, you have used 38% of this model's available context length (42,100/110,000 tokens).",
    );
    expect(title).toContain('61,000 tokens over the whole conversation.');
  });

  it('says the limit is unknown rather than leaving it implied', () => {
    expect(usageTitle({ sent: 42100, received: 900 }, 43000)).toContain(
      "This model's limit is not known.",
    );
  });

  it('says the conversation is past the window rather than at 100%', () => {
    expect(usageTitle({ sent: 12000, received: 10, window: 10000 }, 0)).toContain(
      "you have used more than all of this model's available context length (12,000/10,000 tokens).",
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

describe('recordBytes', () => {
  it('counts what the server measures: recased keys, escaped non-ASCII and slashes', () => {
    const value = { display: [{ createdAt: '1/2', text: 'kai₁ ŋa 𝔸 é' }] };
    // The server's serialization of the value as the client sends it.
    const stored =
      '{"display":[{"created-at":"1\\/2","text":"kai\\u2081 \\u014ba \\ud835\\udd38 \\u00e9"}]}';
    expect(recordBytes(value)).toBe(stored.length);
    // As UTF-8 it would be far less, which is what the meter used to show.
    expect(recordBytes(value)).toBeGreaterThan(
      new TextEncoder().encode(JSON.stringify(value)).length + 15,
    );
  });

  it('leaves the keys inside metadata as they are, as the client sends them', () => {
    const value = { metadata: { myKey: 'a' } };
    expect(recordBytes(value)).toBe('{"metadata":{"myKey":"a"}}'.length);
  });
});

describe('gauge', () => {
  const MB = 1048576;
  const lowContext = { sent: 10_000, window: 100_000 };

  it('shows the fuller of the two limits', () => {
    const storage = gauge(lowContext, { bytes: 3 * MB, cap: 5 * MB });
    expect(storage.which).toBe('storage');
    expect(storage.share).toBeCloseTo(0.6);
    const context = gauge({ sent: 70_000, window: 100_000 }, { bytes: 1 * MB, cap: 5 * MB });
    expect(context.which).toBe('context');
    expect(context.share).toBeCloseTo(0.7);
  });

  it('is nearly full at NEARLY_FULL of either limit', () => {
    const under = NEARLY_FULL - 0.01;
    expect(gauge(lowContext, { bytes: under * 5 * MB, cap: 5 * MB }).nearlyFull).toBe(false);
    expect(gauge(lowContext, { bytes: NEARLY_FULL * 5 * MB, cap: 5 * MB }).nearlyFull).toBe(true);
    const record = { bytes: MB, cap: 5 * MB };
    expect(gauge({ sent: under * 100_000, window: 100_000 }, record).nearlyFull).toBe(false);
    expect(gauge({ sent: NEARLY_FULL * 100_000, window: 100_000 }, record).nearlyFull).toBe(true);
  });

  it('is full when the record has no room left for a message', () => {
    const cap = 5 * MB;
    expect(gauge(lowContext, { bytes: cap - MESSAGE_ROOM - 1, cap }).full).toBe(false);
    expect(gauge(lowContext, { bytes: cap - MESSAGE_ROOM, cap }).full).toBe(true);
    // A record stored under a larger cap than the server has now.
    const over = gauge(lowContext, { bytes: cap * 2, cap });
    expect(over.full).toBe(true);
    expect(over.share).toBe(1);
  });

  it('falls back to the context alone when the record size or cap is unknown', () => {
    const g = gauge(lowContext, { bytes: null, cap: 5 * MB });
    expect(g.which).toBe('context');
    expect(g.full).toBe(false);
    expect(gauge(lowContext, null).which).toBe('context');
    expect(recordShare({ bytes: 10, cap: 0 })).toBeNull();
  });

  it('shows storage when the model window is not known', () => {
    const g = gauge({ sent: 42_000 }, { bytes: MB, cap: 5 * MB });
    expect(g.which).toBe('storage');
    expect(gaugeLabel(g)).toBe('20%');
    expect(gaugeLabel(gauge({ sent: 42_000 }, null))).toBe('42k');
  });
});

describe('gaugeTitle', () => {
  const MB = 1048576;

  it('names the limit the bar shows and gives both, the shown one first', () => {
    const g = gauge({ sent: 10_000, window: 100_000 }, { bytes: 4.6 * MB, cap: 5 * MB });
    const lines = gaugeTitle(g, 30_000).split('\n');
    expect(lines[0]).toBe('The bar shows storage.');
    expect(lines[1]).toBe(
      'In this conversation, you have used 92% of the available storage (4.6 MB/5 MB).',
    );
    expect(lines[2]).toContain('10% of this model');
    expect(lines[3]).toBe('30,000 tokens over the whole conversation.');
  });

  // H10-SCRIPTS polish: a 48 KB record read "0/1 MB".
  it('gives a record under a megabyte in KB', () => {
    const g = gauge(null, { bytes: 48_715, cap: MB });
    expect(gaugeTitle(g, 0)).toBe(
      'In this conversation, you have used 5% of the available storage (48 KB/1 MB).',
    );
  });

  it('names context when context is fuller', () => {
    const g = gauge({ sent: 50_000, window: 100_000 }, { bytes: MB, cap: 5 * MB });
    const lines = gaugeTitle(g, 0).split('\n');
    expect(lines[0]).toBe('The bar shows context length.');
    expect(lines[1]).toContain('50% of this model');
    expect(lines[2]).toContain('20% of the available storage');
  });

  it('is the context tooltip unchanged without a record', () => {
    const usage = { sent: 42_100, window: 110_000 };
    expect(gaugeTitle(gauge(usage, null), 61_000)).toBe(usageTitle(usage, 61_000));
  });
});
