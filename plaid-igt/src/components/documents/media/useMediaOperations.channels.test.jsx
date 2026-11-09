import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountDocumentHook, fakeDocument, fakeClient } from '@/test/mountDocumentHook.jsx';
import { encodeWav } from '@/domain/media/mixdown.js';
import { useMediaOperations } from './useMediaOperations.js';

// The recording's channels on the media hook: how many there are (read off a
// WAV's header the moment the file arrives), the speaker on each (written to
// the document as channelSpeakers, sized to the recording), and which are
// heard (Mute and Solo, a view setting that goes with the recording).

vi.mock('@/utils/feedback', async (importOriginal) => ({
  ...(await importOriginal()),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
}));

const link = () => ({
  url: 'link:rec',
  expiresAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
});

let wav;
beforeEach(() => {
  localStorage.clear();
  wav = new Blob(
    [encodeWav([new Float32Array(16), new Float32Array(16), new Float32Array(16)], 16000)],
    {
      type: 'audio/wav',
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, blob: async () => wav })),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = (h) => h.step(() => new Promise((ok) => setTimeout(ok, 20)));

const mount = async (metadata = {}) => {
  const doc = fakeDocument({
    storedMetadata: metadata,
    document: { id: 'doc-1', mediaUrl: '/api/v1/documents/doc-1/media?v=a' },
  });
  const client = fakeClient({ documents: { mediaLink: vi.fn(async () => link()) } });
  doc.client = client;
  const h = await mountDocumentHook(useMediaOperations, {
    doc,
    ctx: { client, acquireWriteLock: () => null, canWrite: true },
  });
  await settle(h);
  return { h, doc };
};

describe('useMediaOperations channels', () => {
  it('reads the channel count off a WAV as soon as the file is here', async () => {
    const { h } = await mount();
    expect(h.api.channelCount).toBe(3);
    expect(h.api.channelSpeakers).toBeNull();
    await h.unmount();
  });

  it('reads channelSpeakers from the document, and null when there is none', async () => {
    const { h } = await mount({ channelSpeakers: ['Ana', ' Ben ', ''] });
    expect(h.api.channelSpeakers).toEqual(['Ana', 'Ben', '']);
    await h.unmount();
  });

  it('a speaker set on a channel is written sized to the recording', async () => {
    const { h, doc } = await mount();
    await h.step(() => h.api.setChannelSpeaker(1, ' Ben '));
    expect(doc.setMetadataKeys).toHaveBeenCalledWith({ channelSpeakers: ['', 'Ben', ''] });
    await h.unmount();
  });

  it('Mute and Solo toggle per channel', async () => {
    const { h } = await mount();
    expect([...h.api.channelMix.muted]).toEqual([]);
    await h.step(() => h.api.toggleChannelMute(1));
    expect([...h.api.channelMix.muted]).toEqual([1]);
    await h.step(() => h.api.toggleChannelMute(1));
    expect([...h.api.channelMix.muted]).toEqual([]);
    await h.step(() => h.api.toggleChannelSolo(2));
    await h.step(() => h.api.toggleChannelSolo(0));
    expect([...h.api.channelMix.solo].sort()).toEqual([0, 2]);
    await h.unmount();
  });
});
