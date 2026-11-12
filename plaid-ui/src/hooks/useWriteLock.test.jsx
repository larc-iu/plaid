import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
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
    // A run of one step: its own name, its fraction unknown, nothing said yet.
    expect(lock().held).toMatchObject({
      label: 'Auto-analyze',
      steps: ['Auto-analyze'],
      stepIndex: 0,
      percent: null,
      message: '',
    });
    expect(lock().held.startedAt).toBeTypeOf('number');

    await step(() => handle.release());
    expect(lock().held).toBe(null);
  });

  it('keeps the start it is given, so a rejoined run does not restart its clock', async () => {
    const { lock, step } = await mount();
    const startedAt = Date.now() - 90_000;
    await step(() => {
      lock().acquire('Draft', { startedAt });
    });
    expect(lock().held.startedAt).toBe(startedAt);
  });

  it('carries the progress the holder pushes, and ignores any pushed after release', async () => {
    const { lock, step } = await mount();
    let handle;
    await step(() => {
      handle = lock().acquire('Transcribe');
    });
    await step(() => handle.report({ percent: 40, message: 'Transcribing' }));
    expect(lock().held).toMatchObject({ percent: 40, message: 'Transcribing' });
    // A message alone keeps the percent, and an empty one keeps the message.
    await step(() => handle.report({ message: 'Still transcribing' }));
    expect(lock().held).toMatchObject({ percent: 40, message: 'Still transcribing' });
    await step(() => handle.report({ percent: 55, message: '' }));
    expect(lock().held).toMatchObject({ percent: 55, message: 'Still transcribing' });
    // A service's event with no percent says the fraction is unknown, never 0%.
    await step(() => handle.onProgress({ message: 'Loading the model' }));
    expect(lock().held).toMatchObject({ percent: null, message: 'Loading the model' });

    await step(() => handle.release());
    // A progress event that lands after the run ended must not resurrect it.
    await step(() => handle.report({ percent: 99, message: 'too late' }));
    expect(lock().held).toBe(null);
  });

  it('carries the steps of a run that has several, and which one it is on', async () => {
    const { lock, step } = await mount();
    let handle;
    await step(() => {
      handle = lock().acquire('Auto-analyze', { steps: ['Translate', 'Copy', 'Link'] });
    });
    expect(lock().held).toMatchObject({ steps: ['Translate', 'Copy', 'Link'], stepIndex: 0 });
    await step(() => handle.report({ percent: 80, message: 'Sentence 8 of 10' }));
    // A new step starts with its fraction unknown and nothing said yet.
    await step(() => handle.step(1));
    expect(lock().held).toMatchObject({ stepIndex: 1, percent: null, message: '' });
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
    await step(() => lock().held.cancel());
    expect(onCancel).toHaveBeenCalled();

    await step(() => handle.release());
    expect(lock().held).toBe(null);
  });

  // REV-RUN-2: the banner is the only place a run shows once its dialog has
  // closed, and Stop on it said nothing until the worker next spoke for every
  // run but the two that said so themselves.
  it('says "Stopping…" on the banner as soon as Stop is pressed, for every run', async () => {
    const { lock, step } = await mount();
    let resolveCancel;
    const onCancel = vi.fn(() => new Promise((r) => (resolveCancel = r)));
    let handle;
    await step(() => {
      handle = lock().acquire('Parse', { onCancel });
    });
    await step(() => handle.report({ percent: 40, message: 'Sentence 3 of 40.' }));
    await step(() => {
      lock().held.cancel();
    });
    // Before the request to stop has even been answered.
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(lock().held).toMatchObject({ percent: null, message: 'Stopping…' });
    resolveCancel();
    await step(() => handle.release());
  });

  it('has no stop for a run that cannot be stopped', async () => {
    const { lock, step } = await mount();
    await step(() => lock().acquire('Tokenize'));
    expect(lock().held.cancel).toBe(null);
  });
});
