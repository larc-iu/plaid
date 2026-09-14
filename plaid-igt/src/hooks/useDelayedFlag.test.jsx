import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useDelayedFlag } from './useDelayedFlag';

// The spinner over reconcile-on-open. The pass plans locally and touches the
// network only where something needs healing, so on a clean document it is
// over in a microtask and the raw flag puts "Checking this document…" on
// screen for one paint every time a document is opened.

const Probe = ({ active, delayMs }) => (
  <span data-testid="f">{useDelayedFlag(active, delayMs) ? 'shown' : 'hidden'}</span>
);

const read = (container) => container.querySelector('[data-testid="f"]').textContent;

describe('useDelayedFlag', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows nothing for a pass that is over before the delay', async () => {
    const r = await renderComponent(<Probe active />);
    expect(read(r.container)).toBe('hidden');
    await r.rerender(<Probe active={false} />);
    await r.step(() => vi.advanceTimersByTime(1000));
    expect(read(r.container)).toBe('hidden');
    await r.unmount();
  });

  it('shows the flag once the work has run past the delay', async () => {
    const r = await renderComponent(<Probe active />);
    await r.step(() => vi.advanceTimersByTime(150));
    expect(read(r.container)).toBe('shown');
    await r.unmount();
  });

  it('drops it the instant the work ends, with nothing lingering', async () => {
    const r = await renderComponent(<Probe active />);
    await r.step(() => vi.advanceTimersByTime(150));
    expect(read(r.container)).toBe('shown');
    await r.rerender(<Probe active={false} />);
    expect(read(r.container)).toBe('hidden');
    await r.unmount();
  });

  it('takes a delay of its own', async () => {
    const r = await renderComponent(<Probe active delayMs={500} />);
    await r.step(() => vi.advanceTimersByTime(499));
    expect(read(r.container)).toBe('hidden');
    await r.step(() => vi.advanceTimersByTime(1));
    expect(read(r.container)).toBe('shown');
    await r.unmount();
  });
});
