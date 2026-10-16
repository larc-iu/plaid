import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// A recording converted to PCM WAV while the ELAN importer reads it is named
// on screen until the conversion is done (REV-FX7-ADPCM, the Media tab and the
// FLEx importer say the same).
const gate = vi.hoisted(() => ({ open: null }));
vi.mock('@/utils/readyRecordings', () => ({
  readyRecordings: async (files, options) => {
    options?.onConvert?.(files[0].name);
    await new Promise((r) => {
      gate.open = r;
    });
    return files;
  },
}));
vi.mock('@/utils/feedback', () => ({ notifyError: vi.fn(), notifyInfo: vi.fn() }));
const { useElanBatch } = await import('./useElanBatch');

const Probe = ({ onReady }) => {
  onReady(useElanBatch());
  return null;
};

describe('useElanBatch converting a recording', () => {
  it('names it while it converts, and nothing after', async () => {
    let last = null;
    const v = await renderComponent(<Probe onReady={(b) => (last = b)} />);
    let reading;
    await v.step(() => {
      reading = last.readFiles([new File(['x'], 'story.wav')]);
    });
    expect(last.decoding).toBe('story.wav');
    await v.step(async () => {
      gate.open();
      await reading;
    });
    expect(last.decoding).toBe(null);
    expect(last.mediaFiles.map((f) => f.name)).toEqual(['story.wav']);
    await v.unmount();
  });
});
