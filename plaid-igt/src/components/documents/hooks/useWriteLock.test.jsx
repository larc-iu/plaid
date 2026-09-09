import { describe, it, expect, vi } from 'vitest';
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
    let handle;
    await step(() => {
      handle = lock().acquire('Auto-analyze');
    });
    expect(lock().held).toMatchObject({ label: 'Auto-analyze', status: '' });
    expect(lock().held.startedAt).toBeTypeOf('number');

    await step(() => handle.release());
    expect(lock().held).toBe(null);
  });

  it('carries the status the holder pushes, and ignores one pushed after release', async () => {
    const { lock, step } = await mount();
    let handle;
    await step(() => {
      handle = lock().acquire('Transcribe');
    });
    await step(() => handle.setStatus('Transcribing, 40%'));
    expect(lock().held.status).toBe('Transcribing, 40%');

    await step(() => handle.release());
    // A progress event that lands after the run ended must not resurrect it.
    await step(() => handle.setStatus('too late'));
    expect(lock().held).toBe(null);
  });

  it('refuses a second holder while one has it', async () => {
    const { lock, step } = await mount();
    let first;
    await step(() => {
      first = lock().acquire('Tokenize');
    });
    expect(lock().acquire('Transcribe')).toBe(null);
    expect(lock().held).toMatchObject({ label: 'Tokenize' });

    await step(() => first.release());
    let second;
    await step(() => {
      second = lock().acquire('Transcribe');
    });
    expect(second.release).toBeTypeOf('function');
    expect(lock().held).toMatchObject({ label: 'Transcribe' });
  });

  it('refuses a second holder acquired in the same tick', async () => {
    // Two clicks before React re-renders: the ref arbitrates, not the state.
    const { lock, step } = await mount();
    let a, b;
    await step(() => {
      a = lock().acquire('Tokenize');
      b = lock().acquire('Auto-analyze');
    });
    expect(a.release).toBeTypeOf('function');
    expect(b).toBe(null);
    expect(lock().held).toMatchObject({ label: 'Tokenize' });
  });

  it('ignores a release called twice, so it cannot free a later run', async () => {
    const { lock, step } = await mount();
    let first;
    await step(() => {
      first = lock().acquire('Tokenize');
    });
    await step(() => first.release());

    let second;
    await step(() => {
      second = lock().acquire('Auto-analyze');
    });
    // The stale release from the finished run must not unlock the new one.
    await step(() => first.release());
    expect(lock().held).toMatchObject({ label: 'Auto-analyze' });
    await step(() => second.release());
    expect(lock().held).toBe(null);
  });

  it("carries the holder's way to stop the run", async () => {
    // A rejoined run lives in its own hook, so no dialog on the page has a
    // handle on it; the lock is what makes it stoppable from anywhere.
    const { lock, step } = await mount();
    const onCancel = vi.fn();
    let handle;
    await step(() => {
      handle = lock().acquire('Transcribe', { onCancel });
    });
    expect(lock().held.cancel).toBe(onCancel);
    lock().held.cancel();
    expect(onCancel).toHaveBeenCalled();

    await step(() => handle.release());
    expect(lock().held).toBe(null);
  });

  it('has no stop for a run that cannot be stopped', async () => {
    const { lock, step } = await mount();
    await step(() => lock().acquire('Tokenize'));
    expect(lock().held.cancel).toBe(null);
  });
});
