import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { useRunProgress, useMirroredProgress, formatElapsed } from './useRunProgress.js';

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

// Two spots on one screen, both mirroring the one `useServiceRequest`, which is
// exactly IGT's Media tab: detect speech and transcribe. The source keeps the
// finished run's percent and message until the next run calls `begin()`, so the
// spot that had mirrored nothing yet opened by showing the OTHER run's last
// line under a bar that had just started.
async function mountTwoSpots() {
  const seen = { current: null };
  const Probe = ({ percent = null, message = '' }) => {
    const detect = useRunProgress();
    const transcribe = useRunProgress();
    useMirroredProgress(detect, { percent, message, active: detect.running });
    useMirroredProgress(transcribe, { percent, message, active: transcribe.running });
    seen.current = { detect, transcribe };
    return null;
  };
  const r = await renderComponent(<Probe />);
  return {
    ...r,
    spots: () => seen.current,
    // What the shared source is saying right now.
    async source(percent, message) {
      await r.rerender(<Probe percent={percent} message={message} />);
    },
  };
}

describe('mirroring one service channel onto several spots', () => {
  it('does not open a run with the previous run\u2019s last line', async () => {
    const m = await mountTwoSpots();
    await m.step(() => m.spots().detect.start(['Detect speech']));
    await m.source(100, 'Finished.');
    expect(m.spots().detect.message).toBe('Finished.');

    await m.step(() => m.spots().detect.finish());
    // The source still says what detect left it saying.
    await m.step(() => m.spots().transcribe.start(['Transcribe']));
    expect(m.spots().transcribe.message).toBe('Transcribe');
    expect(m.spots().transcribe.percent).toBe(null);

    // And the new run's own first word does get through.
    await m.source(null, 'Starting the service\u2026');
    expect(m.spots().transcribe.message).toBe('Starting the service\u2026');
    await m.unmount();
  });

  it('passes on every update a run makes of its own', async () => {
    const m = await mountTwoSpots();
    await m.step(() => m.spots().transcribe.start(['Transcribe']));
    await m.source(null, 'Starting the service\u2026');
    await m.source(20, 'Transcribing\u2026');
    expect(m.spots().transcribe.percent).toBe(20);
    expect(m.spots().transcribe.message).toBe('Transcribing\u2026');
    await m.source(80, 'Transcribing\u2026');
    expect(m.spots().transcribe.percent).toBe(80);
    await m.unmount();
  });

  it('mirrors onto the spot that is running and no other', async () => {
    const m = await mountTwoSpots();
    await m.step(() => m.spots().detect.start(['Detect speech']));
    await m.source(40, 'Detecting\u2026');
    expect(m.spots().detect.message).toBe('Detecting\u2026');
    expect(m.spots().transcribe.running).toBe(false);
    expect(m.spots().transcribe.message).toBe('Working\u2026');
    await m.unmount();
  });

  it('starts clean on a second run of the same spot', async () => {
    const m = await mountTwoSpots();
    await m.step(() => m.spots().transcribe.start(['Transcribe']));
    await m.source(100, 'Finished.');
    await m.step(() => m.spots().transcribe.finish());
    await m.step(() => m.spots().transcribe.start(['Transcribe']));
    expect(m.spots().transcribe.message).toBe('Transcribe');
    await m.unmount();
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
