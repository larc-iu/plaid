import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useRunProgress, formatElapsed } from './useRunProgress.js';

// These are the rules that keep a working run from reading as a hung one.

async function mount() {
  const seen = { current: null };
  const Probe = () => {
    seen.current = useRunProgress();
    return null;
  };
  const r = await renderComponent(<Probe />);
  return { ...r, run: () => seen.current };
}

describe('useRunProgress', () => {
  afterEach(() => vi.useRealTimers());

  it('is idle until a run starts', async () => {
    const { run } = await mount();
    expect(run().running).toBe(false);
    expect(run().percent).toBe(null);
  });

  it('leaves the bar indeterminate until a fraction is actually known', async () => {
    const { run, step } = await mount();
    await step(() => run().start(['Tokenize']));
    expect(run().running).toBe(true);
    // Null, not 0: a determinate bar pinned at zero reads as broken.
    expect(run().percent).toBe(null);
    await step(() => run().report({ percent: 40 }));
    expect(run().percent).toBe(40);
  });

  it('never shows a blank status line', async () => {
    const { run, step } = await mount();
    await step(() => run().start(['Tokenize']));
    expect(run().message).toBe('Tokenize');
    await step(() => run().report({ message: 'Segmenting…' }));
    expect(run().message).toBe('Segmenting…');
    // An update carrying only a percent keeps the last real message.
    await step(() => run().report({ percent: 60 }));
    expect(run().message).toBe('Segmenting…');
  });

  it('spreads the bar across the steps of a multi-step run', async () => {
    const { run, step } = await mount();
    await step(() => run().start(['One', 'Two', 'Three', 'Four']));
    expect(run().stepCount).toBe(4);
    expect(run().percent).toBe(0);

    await step(() => run().report({ percent: 50 }));
    expect(run().percent).toBe(12.5); // half of the first quarter

    await step(() => run().step(2));
    expect(run().percent).toBe(50); // two of four done
    expect(run().message).toBe('Three');
    // A new step starts with its own fraction unknown, not inherited.
    await step(() => run().report({ percent: 50 }));
    expect(run().percent).toBe(62.5);
  });

  it('ticks the elapsed clock while a worker says nothing', async () => {
    vi.useFakeTimers();
    const { run, step } = await mount();
    await step(() => run().start(['Analyze']));
    expect(run().elapsedMs).toBe(0);
    await step(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(run().elapsedMs).toBeGreaterThanOrEqual(3000);
    // Nothing was reported in that time, and the bar is still unknown.
    expect(run().percent).toBe(null);
  });

  it('stops the clock when the run finishes', async () => {
    vi.useFakeTimers();
    const { run, step } = await mount();
    await step(() => run().start(['Analyze']));
    await step(() => run().finish());
    expect(run().running).toBe(false);
    const settled = run().elapsedMs;
    await step(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(run().elapsedMs).toBe(settled);
  });
});

describe('formatElapsed', () => {
  it('counts m:ss, and past an hour rather than wrapping', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7_000)).toBe('0:07');
    expect(formatElapsed(69_000)).toBe('1:09');
    expect(formatElapsed(3_671_000)).toBe('61:11');
  });
});
