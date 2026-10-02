import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useRecordingConversion } from './useRecordingConversion';
import { notifyWarning } from '@/utils/feedback';

// A long recording's conversion can be stopped (R2-DEBT-APPS-24): the file in
// progress is left as it was, the ones after it are not started, and the ones
// already converted stay converted.

vi.mock('@/utils/feedback', () => ({ notifyError: vi.fn(), notifyWarning: vi.fn() }));

// Each conversion waits until it is let go or stopped, as a long encode does.
const pending = [];
vi.mock('@/domain/media/transcodeToMp3', () => ({
  transcodeToMp3: (file, { signal }) =>
    new Promise((resolve) => {
      pending.push(() => resolve(new File(['x'], `${file.name}.mp3`)));
      // The worker answers a cancel with a message of its own, a moment later.
      signal?.addEventListener('abort', () => setTimeout(() => resolve(null), 0), { once: true });
    }),
}));

const Probe = ({ setMediaFiles, onReady }) => {
  onReady(useRecordingConversion(setMediaFiles));
  return null;
};

describe('stopping a conversion', () => {
  it('keeps what was converted, leaves the rest, and says so', async () => {
    let media = ['a', 'b', 'c'].map((n) => new File(['y'], n));
    const originals = [...media];
    const setMediaFiles = (f) => (media = f(media));
    let hook;
    const view = await renderComponent(
      <Probe setMediaFiles={setMediaFiles} onReady={(h) => (hook = h)} />,
    );
    let run;
    await view.step(() => {
      run = hook.convertRecordings(originals);
    });
    expect(hook.converting).toMatchObject({ name: 'a', index: 0, total: 3 });
    await view.step(async () => pending.shift()());
    expect(hook.converting).toMatchObject({ name: 'b', index: 1 });
    await view.step(() => hook.stopConverting());
    expect(hook.converting).toMatchObject({ stopping: true });
    await view.step(async () => {
      await run;
    });
    expect(hook.converting).toBeNull();
    expect(media.map((f) => f.name)).toEqual(['a.mp3', 'b', 'c']);
    expect(pending).toHaveLength(1); // b's, never let go, and no c
    expect(notifyWarning).toHaveBeenCalledWith('Converted 1 of 3.', 'Conversion stopped');
    await view.unmount();
  });
});
