import { describe, it, expect } from 'vitest';
import { renderComponent } from '@/test/renderComponent.jsx';
import { useWriteLock } from './useWriteLock.js';

// The lock is what stops a linguist editing under a service run they closed
// the dialog on, and what stops a second run starting on top of the first.

async function mount() {
  const seen = { current: null };
  const Probe = () => {
    seen.current = useWriteLock();
    return null;
  };
  const r = await renderComponent(<Probe />);
  return { ...r, lock: () => seen.current };
}

describe('useWriteLock', () => {
  it('starts unheld', async () => {
    const { lock } = await mount();
    expect(lock().held).toBe(null);
  });

  it('names the run that holds it, and frees it on release', async () => {
    const { lock, step } = await mount();
    let release;
    await step(() => {
      release = lock().acquire('Auto-analyze');
    });
    expect(lock().held).toEqual({ label: 'Auto-analyze' });

    await step(() => release());
    expect(lock().held).toBe(null);
  });

  it('refuses a second holder while one has it', async () => {
    const { lock, step } = await mount();
    let first;
    await step(() => {
      first = lock().acquire('Tokenize');
    });
    expect(lock().acquire('Transcribe')).toBe(null);
    expect(lock().held).toEqual({ label: 'Tokenize' });

    await step(() => first());
    let second;
    await step(() => {
      second = lock().acquire('Transcribe');
    });
    expect(second).toBeTypeOf('function');
    expect(lock().held).toEqual({ label: 'Transcribe' });
  });

  it('refuses a second holder acquired in the same tick', async () => {
    // Two clicks before React re-renders: the ref arbitrates, not the state.
    const { lock, step } = await mount();
    let a, b;
    await step(() => {
      a = lock().acquire('Tokenize');
      b = lock().acquire('Auto-analyze');
    });
    expect(a).toBeTypeOf('function');
    expect(b).toBe(null);
    expect(lock().held).toEqual({ label: 'Tokenize' });
  });

  it('ignores a release called twice, so it cannot free a later run', async () => {
    const { lock, step } = await mount();
    let first;
    await step(() => {
      first = lock().acquire('Tokenize');
    });
    await step(() => first());

    let second;
    await step(() => {
      second = lock().acquire('Auto-analyze');
    });
    // The stale release from the finished run must not unlock the new one.
    await step(() => first());
    expect(lock().held).toEqual({ label: 'Auto-analyze' });
    await step(() => second());
    expect(lock().held).toBe(null);
  });
});
