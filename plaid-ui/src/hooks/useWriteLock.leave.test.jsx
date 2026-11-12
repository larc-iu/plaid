import { StrictMode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { useWriteLock } from './useWriteLock.js';

// Leaving while a run holds the document (Luke, 2026-11-12: "Stop after the
// current step, and warn"). Closing or reloading the tab asks first, through
// the app's one leave question (useSavingGuard). Leaving inside the app
// unmounts the page that owns the lock, and its holder is told.

// Whether the browser would be told to ask.
const asks = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

const mount = async (wrap = (x) => x) => {
  const seen = { current: null };
  const Probe = () => {
    seen.current = useWriteLock();
    return null;
  };
  const view = await renderComponent(wrap(<Probe />));
  return { ...view, lock: () => seen.current };
};

describe('useWriteLock when the page goes', () => {
  it('asks before the tab closes or reloads while a run holds it, and not after', async () => {
    const { lock, step, unmount } = await mount();
    expect(asks()).toBe(false);
    let handle;
    await step(() => {
      handle = lock().acquire('Auto-analyze');
    });
    expect(asks()).toBe(true);
    await step(() => handle.release());
    expect(asks()).toBe(false);
    await unmount();
  });

  it("tells the holder and lets go when the document's page unmounts", async () => {
    const onLeave = vi.fn();
    const { lock, step, unmount } = await mount();
    let handle;
    await step(() => {
      handle = lock().acquire('Auto-analyze', { onLeave });
    });
    await unmount();
    await tick();
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(asks()).toBe(false);
    // The run's own release later is a no-op.
    handle.release();
    expect(asks()).toBe(false);
  });

  it('tells nobody when the run ended before the page went', async () => {
    const onLeave = vi.fn();
    const { lock, step, unmount } = await mount();
    await step(() => lock().acquire('Parse', { onLeave }).release());
    await unmount();
    await tick();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('does not take StrictMode mounting a page twice for leaving it', async () => {
    const onLeave = vi.fn();
    const { lock, step, unmount } = await mount((x) => <StrictMode>{x}</StrictMode>);
    await step(() => {
      lock().acquire('Auto-analyze', { onLeave });
    });
    await tick();
    expect(onLeave).not.toHaveBeenCalled();
    expect(lock().held).toMatchObject({ label: 'Auto-analyze' });
    await unmount();
    await tick();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
