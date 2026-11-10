import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The mix dialog: what each file is said to be, the speaker and offset per
// file, the two qualities with their sizes, the refusal of a mix the server
// would not take, and what the upload is handed. The decode and the mix are
// the seams: a track's samples are a handful of numbers, and the mix is a
// WAV header the test can read.

const { mixTracks } = vi.hoisted(() => ({ mixTracks: vi.fn() }));
vi.mock('@/domain/media/mixRecordings', () => ({
  readTrack: vi.fn(),
  mixTracks,
}));
vi.mock('@/utils/feedback', () => ({ notifyError: vi.fn() }));

const { MixRecordingsDialog } = await import('./MixRecordingsDialog.jsx');

const MB = 1000 * 1000;
const fileOf = (name) => new File(['x'], name, { type: 'audio/wav' });
const decoded = {
  'ana.wav': { sampleRate: 48000, channels: 1, seconds: 10 },
  'ben.wav': { sampleRate: 44100, channels: 2, seconds: 8 },
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

  it('starts on Smaller when only the smaller mix fits, and refuses Full when it is chosen', async () => {
    const onUpload = vi.fn();
    await mount({ maxBytes: 1 * MB, onUpload });
    expect(document.body.querySelector('input[value="small"]').checked).toBe(true);
    expect(text()).not.toContain('This server accepts');
    expect(button('Upload').disabled).toBe(false);
    await view.step(() => document.body.querySelector('input[value="full"]').click());
    expect(text()).toContain('This server accepts 1.0 MB. The mix is 1.9 MB.');
    expect(button('Upload').disabled).toBe(true);
  });

  it('starts on Full when it fits, and when neither fits', async () => {
    await mount({ maxBytes: 2 * MB });
    expect(document.body.querySelector('input[value="full"]').checked).toBe(true);
    await view.unmount();
    await mount({ maxBytes: 0.5 * MB });
    expect(document.body.querySelector('input[value="full"]').checked).toBe(true);
    expect(text()).toContain('This server accepts 500 KB. The mix is 1.9 MB.');
    expect(button('Upload').disabled).toBe(true);
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
    expect(tracks.map((t) => [t.file.name, t.name, t.offset])).toEqual([
      ['ana.wav', 'ana.wav', 0],
      ['ben.wav', 'ben.wav', 1.5],
    ]);
    expect(options.signal.aborted).toBe(false);
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

  it('a file that cannot be decoded can be removed, and the rest are mixed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onUpload = vi.fn();
    const mixed = new File(['wav'], 'mixed.wav', { type: 'audio/wav' });
    mixTracks.mockResolvedValue(mixed);
    // The broken file comes first, and ben is still being read when it is
    // removed: ben's answer lands in ben's row.
    let finishBen;
    const reading = vi.fn((file) => {
      if (file.name === 'bad.wav') return Promise.reject(new Error('EncodingError'));
      if (file.name === 'ben.wav')
        return new Promise((ok) => {
          finishBen = () => ok({ name: file.name, ...decoded[file.name] });
        });
      return Promise.resolve({ name: file.name, ...decoded[file.name] });
    });
    await mount({
      decode: reading,
      onUpload,
      files: [fileOf('bad.wav'), fileOf('ben.wav'), fileOf('ana.wav')],
    });
    expect(text()).toContain('Cannot be decoded.');
    await view.step(() => field('Remove bad.wav').click());
    expect(text()).not.toContain('bad.wav');
    await view.step(() => finishBen());
    await settled();
    expect(text()).toContain('0:08.000 · stereo, mixed to one channel · 44.1 kHz');
    expect(text()).toContain('0:10.000 · mono · 48 kHz');
    expect(button('Upload').disabled).toBe(false);
    await type(field('ben.wav speaker'), 'Ben');
    await view.step(() => button('Upload').click());
    await settled();
    expect(mixTracks.mock.calls[0][0].map((t) => t.name)).toEqual(['ben.wav', 'ana.wav']);
    expect(onUpload).toHaveBeenCalledWith(mixed, { channelSpeakers: ['Ben', ''] });
    vi.restoreAllMocks();
  });

  it('one file left after a removal is not mixed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = vi.fn(async (file) => {
      if (file.name === 'ben.wav') throw new Error('EncodingError');
      return { name: file.name, ...decoded[file.name] };
    });
    await mount({ decode: failing });
    await view.step(() => field('Remove ben.wav').click());
    expect(text()).toContain('A mix takes two files or more.');
    expect(button('Upload').disabled).toBe(true);
    vi.restoreAllMocks();
  });

  it('reads one file at a time, and closing stops the reads left', async () => {
    let finish;
    const reading = vi.fn(
      (file, { signal }) =>
        new Promise((ok) => {
          finish = () => ok({ name: file.name, ...decoded[file.name], signal });
        }),
    );
    const files = [fileOf('ana.wav'), fileOf('ben.wav')];
    await mount({ decode: reading, files });
    expect(reading).toHaveBeenCalledTimes(1);
    const { signal } = reading.mock.calls[0][1];
    await view.rerender(
      <MixRecordingsDialog
        open={false}
        files={files}
        onOpenChange={() => {}}
        onUpload={() => {}}
        decode={reading}
      />,
    );
    expect(signal.aborted).toBe(true);
    finish();
    await settled();
    expect(reading).toHaveBeenCalledTimes(1);
  });

  it('closing while it mixes stops the mix, and nothing is uploaded', async () => {
    const onUpload = vi.fn();
    let options;
    mixTracks.mockImplementation((_tracks, opts) => {
      options = opts;
      return new Promise(() => {});
    });
    await mount({ onUpload });
    await view.step(() => button('Upload').click());
    expect(options.signal.aborted).toBe(false);
    await view.unmount();
    view = null;
    expect(options.signal.aborted).toBe(true);
    expect(onUpload).not.toHaveBeenCalled();
  });

  // Cancel and the Close X while it mixes stop the mix and leave the dialog
  // as it was before Upload: open, its fields as they were, Upload ready to
  // press again. Nothing is uploaded and nothing is said when the stopped mix
  // ends, however it ends.
  it.each([
    [
      'Cancel',
      'rejects',
      () => button('Cancel'),
      (m) => m.reject(new DOMException('', 'AbortError')),
    ],
    [
      'the Close X',
      'finishes',
      () => button('Close Mix recordings'),
      (m) => m.resolve(new File(['w'], 'mix.wav')),
    ],
  ])(
    '%s while it mixes stops the mix and leaves the dialog ready, even when the mix %s',
    async (_, _how, control, end) => {
      const { notifyError } = await import('@/utils/feedback');
      notifyError.mockClear();
      const onUpload = vi.fn();
      const onOpenChange = vi.fn();
      const mixes = [];
      mixTracks.mockImplementation((_tracks, opts) => {
        let resolve;
        let reject;
        const promise = new Promise((ok, no) => {
          resolve = ok;
          reject = no;
        });
        mixes.push({ signal: opts.signal, resolve, reject });
        return promise;
      });
      await mount({ onUpload, onOpenChange });
      await type(field('ana.wav speaker'), 'Ana');
      await type(field('ben.wav offset in seconds'), '1.5');
      await view.step(() => button('Upload').click());
      expect(control().disabled).toBe(false);
      await view.step(() => control().click());
      expect(mixes[0].signal.aborted).toBe(true);
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      expect(text()).not.toContain('Mixing');
      expect(field('ana.wav speaker').value).toBe('Ana');
      expect(field('ana.wav speaker').disabled).toBe(false);
      expect(field('ben.wav offset in seconds').value).toBe('1.5');
      expect(button('Upload').disabled).toBe(false);
      await view.step(async () => {
        end(mixes[0]);
        await new Promise((ok) => setTimeout(ok, 10));
      });
      expect(onUpload).not.toHaveBeenCalled();
      expect(notifyError).not.toHaveBeenCalled();
      expect(button('Upload').disabled).toBe(false);
      // Upload again mixes again, under a signal of its own.
      await view.step(() => button('Upload').click());
      expect(mixes).toHaveLength(2);
      expect(mixes[1].signal.aborted).toBe(false);
      await view.step(async () => {
        mixes[1].resolve(new File(['w'], 'mix.wav'));
        await new Promise((ok) => setTimeout(ok, 10));
      });
      expect(onUpload).toHaveBeenCalledTimes(1);
      expect(onUpload.mock.calls[0][1]).toEqual({ channelSpeakers: ['Ana', ''] });
    },
  );

  // REV-MIX-D-1: the mix works from what the fields held at the click, so a
  // speaker or an offset typed while it ran was shown and never used.
  it('takes no speaker or offset while it mixes', async () => {
    mixTracks.mockImplementation(() => new Promise(() => {}));
    await mount();
    const fields = () =>
      [
        'ana.wav speaker',
        'ben.wav speaker',
        'ana.wav offset in seconds',
        'ben.wav offset in seconds',
      ].map((label) => field(label).disabled);
    expect(fields()).toEqual([false, false, false, false]);
    await view.step(() => button('Upload').click());
    expect(fields()).toEqual([true, true, true, true]);
  });

  it('says a video row keeps only its sound, by the type the browser gives', async () => {
    const files = [
      new File(['x'], 'cam.wav', { type: 'video/mp4' }),
      new File(['x'], 'ben.mp4', { type: 'audio/mp4' }),
    ];
    const read = vi.fn(async (file) => ({ name: file.name, ...decoded['ana.wav'] }));
    await mount({ decode: read, files });
    const rows = all(document.body, 'li').map((li) => li.textContent);
    expect(rows[0]).toContain('0:10.000 · mono · 48 kHz · video, sound only');
    expect(rows[1]).not.toContain('video');
  });

  it('names no rate for Full quality until every file is read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const waiting = vi.fn(() => new Promise(() => {}));
    await mount({ decode: waiting });
    expect(text()).toContain('Full quality');
    expect(text()).not.toContain('Full quality (');
    await view.unmount();
    const failing = vi.fn(async (file) => {
      if (file.name === 'ben.wav') throw new Error('EncodingError');
      return { name: file.name, ...decoded[file.name] };
    });
    await mount({ decode: failing });
    expect(text()).toContain('Cannot be decoded.');
    expect(text()).toContain('Full quality');
    expect(text()).not.toContain('Full quality (');
    vi.restoreAllMocks();
  });
});
