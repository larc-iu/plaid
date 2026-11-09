import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The mix dialog: what each file is said to be, the speaker and offset per
// file, the two qualities with their sizes, the refusal of a mix the server
// would not take, and what the upload is handed. The decode and the mix are
// the seams: a track's samples are a handful of numbers, and the mix is a
// WAV header the test can read.

const { mixTracks } = vi.hoisted(() => ({ mixTracks: vi.fn() }));
vi.mock('@/domain/media/mixRecordings', () => ({
  decodeTrack: vi.fn(),
  mixTracks,
}));
vi.mock('@/utils/feedback', () => ({ notifyError: vi.fn() }));

const { MixRecordingsDialog } = await import('./MixRecordingsDialog.jsx');

const MB = 1000 * 1000;
const fileOf = (name) => new File(['x'], name, { type: 'audio/wav' });
const decoded = {
  'ana.wav': { sampleRate: 48000, channels: 1, seconds: 10, mono: new Float32Array(2) },
  'ben.wav': { sampleRate: 44100, channels: 2, seconds: 8, mono: new Float32Array(2) },
};
const decode = vi.fn(async (file) => ({ name: file.name, ...decoded[file.name] }));

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
  mixTracks.mockReset();
});

// Dialog content renders in a portal, so the document is what is read.
const text = () => document.body.textContent.replace(/\s+/g, ' ');
const button = (label) => all(document.body, 'button').find((b) => b.textContent.trim() === label);
const field = (label) => document.body.querySelector(`[aria-label="${label}"]`);
const type = async (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  await view.step(() => el.dispatchEvent(new Event('input', { bubbles: true })));
};
const settled = () => view.step(async () => new Promise((ok) => setTimeout(ok, 10)));

const mount = async (props = {}) => {
  view = await renderComponent(
    <MixRecordingsDialog
      open
      files={[fileOf('ana.wav'), fileOf('ben.wav')]}
      onOpenChange={() => {}}
      onUpload={() => {}}
      decode={decode}
      {...props}
    />,
  );
  await settled();
};

describe('MixRecordingsDialog', () => {
  it('offers only the full quality when no file is above the smaller rate', async () => {
    decode.mockImplementation(async (file) => ({
      name: file.name,
      ...decoded[file.name],
      sampleRate: 16000,
    }));
    try {
      await mount();
      expect(text()).toContain('Full quality (16 kHz)');
      expect(text()).not.toContain('Smaller');
      expect(document.body.querySelector('input[value="small"]')).toBe(null);
    } finally {
      decode.mockImplementation(async (file) => ({ name: file.name, ...decoded[file.name] }));
    }
  });

  it('lists each file with its length, channels and rate, and offers the two qualities with sizes', async () => {
    await mount({ knownSpeakers: ['Ana'] });
    expect(text()).toContain('ana.wav');
    expect(text()).toContain('0:10.000 · mono · 48 kHz');
    expect(text()).toContain('0:08.000 · stereo, mixed to one channel · 44.1 kHz');
    // Two channels, 10 s at the higher rate, 16-bit.
    expect(text()).toContain('Full quality (48 kHz)· 1.9 MB');
    expect(text()).toContain('Smaller (16 kHz)· 640 KB');
    expect(document.body.querySelector('datalist option[value="Ana"]')).toBeTruthy();
    expect(button('Upload').disabled).toBe(false);
  });

  it('refuses a mix over the server limit before anything is uploaded, and the smaller mix gets through', async () => {
    const onUpload = vi.fn();
    await mount({ maxBytes: 1 * MB, onUpload });
    expect(text()).toContain('This server accepts 1.0 MB. The mix is 1.9 MB.');
    expect(button('Upload').disabled).toBe(true);
    await view.step(() => document.body.querySelector('input[value="small"]').click());
    expect(text()).not.toContain('This server accepts');
    expect(button('Upload').disabled).toBe(false);
  });

  it('hands the upload the mixed file and the speakers in channel order, offsets applied', async () => {
    const onUpload = vi.fn();
    const onOpenChange = vi.fn();
    const mixed = new File(['wav'], 'ana (mixed, 2 speakers).wav', { type: 'audio/wav' });
    mixTracks.mockResolvedValue(mixed);
    await mount({ onUpload, onOpenChange });
    await type(field('ana.wav speaker'), 'Ana');
    await type(field('ben.wav speaker'), ' Ben ');
    await type(field('ben.wav offset in seconds'), '1.5');
    await view.step(() => button('Upload').click());
    await settled();
    expect(mixTracks).toHaveBeenCalledTimes(1);
    const [tracks, options] = mixTracks.mock.calls[0];
    expect(tracks.map((t) => [t.name, t.offset])).toEqual([
      ['ana.wav', 0],
      ['ben.wav', 1.5],
    ]);
    expect(options.quality).toBe('full');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onUpload).toHaveBeenCalledWith(mixed, { channelSpeakers: ['Ana', 'Ben'] });
  });

  it('an offset changes the size it says', async () => {
    await mount();
    await type(field('ben.wav offset in seconds'), '5');
    // ben runs 8 s from 5 s, so the mix is 13 s long.
    expect(text()).toContain('Smaller (16 kHz)· 832 KB');
  });

  it('a file that cannot be decoded is said so and blocks the upload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = vi.fn(async (file) => {
      if (file.name === 'ben.wav') throw new Error('EncodingError');
      return { name: file.name, ...decoded[file.name] };
    });
    await mount({ decode: failing });
    expect(text()).toContain('Cannot be decoded.');
    expect(button('Upload').disabled).toBe(true);
    vi.restoreAllMocks();
  });
});
