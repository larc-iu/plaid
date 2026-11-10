import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { ChannelSpeakersDialog } from './ChannelSpeakersDialog.jsx';

// One file with a speaker per channel, chosen under Per speaker: no mix, a
// speaker per channel, and a WAV uploaded as it is with the
// speakers. Any other recording is uploaded as a WAV of the same channels, at
// the quality chosen. A file with one channel is said to need more, and
// nothing is uploaded.

let view;
afterEach(async () => {
  vi.restoreAllMocks();
  await view?.unmount();
  view = null;
});

const text = () => document.body.textContent.replace(/\s+/g, ' ');
const button = (label) => all(document.body, 'button').find((b) => b.textContent.trim() === label);
const field = (label) => document.body.querySelector(`[aria-label="${label}"]`);
const type = async (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  await view.step(() => el.dispatchEvent(new Event('input', { bubbles: true })));
};
const settled = () => view.step(async () => new Promise((ok) => setTimeout(ok, 10)));

const fileOf = (name, size = 1000) => {
  const file = new File(['x'], name, { type: 'audio/wav' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

const mount = async (channels, props = {}) => {
  view = await renderComponent(
    <ChannelSpeakersDialog
      open
      file={fileOf('interview.wav')}
      onOpenChange={() => {}}
      onUpload={() => {}}
      readFile={async () => ({ channels, convert: false })}
      {...props}
    />,
  );
  await settled();
};

describe('ChannelSpeakersDialog', () => {
  it('asks a speaker per channel and uploads the file as it is with them', async () => {
    const onUpload = vi.fn();
    const onOpenChange = vi.fn();
    const file = fileOf('interview.wav');
    await mount(2, { onUpload, onOpenChange, file, knownSpeakers: ['Ana'] });
    expect(text()).toContain('Speakers per channel');
    expect(text()).toContain('interview.wav');
    await type(field('Channel 1 speaker'), ' Ana ');
    await type(field('Channel 2 speaker'), 'Ben');
    await view.step(() => button('Upload').click());
    expect(onUpload).toHaveBeenCalledWith(file, { channelSpeakers: ['Ana', 'Ben'] });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a speaker may be left empty', async () => {
    const onUpload = vi.fn();
    await mount(3, { onUpload });
    await type(field('Channel 2 speaker'), 'Ben');
    await view.step(() => button('Upload').click());
    expect(onUpload.mock.calls[0][1]).toEqual({ channelSpeakers: ['', 'Ben', ''] });
  });

  it('a file with one channel needs more, and nothing is uploaded', async () => {
    const onUpload = vi.fn();
    await mount(1, { onUpload });
    expect(text()).toContain(
      'One channel. Choose two or more files, or a file with a channel per speaker.',
    );
    expect(field('Channel 1 speaker')).toBeNull();
    expect(button('Upload').disabled).toBe(true);
  });

  it('a file the server would refuse is refused here', async () => {
    const onUpload = vi.fn();
    await mount(2, {
      onUpload,
      file: fileOf('big.wav', 300 * 1000 * 1000),
      maxBytes: 200 * 1000 * 1000,
    });
    expect(text()).toContain('This server accepts 200 MB.');
    expect(button('Upload').disabled).toBe(true);
  });

  it('a file that cannot be read is said so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount(null, {
      readFile: async () => {
        throw new Error('bad');
      },
    });
    expect(text()).toContain('Cannot be decoded.');
    expect(button('Upload').disabled).toBe(true);
  });

  // A stereo MP3 of 10 s at 44.1 kHz: 1,764,044 bytes as a WAV at its own
  // rate, 640,044 at 16 kHz.
  const mp3Read = { name: 'talk.mp3', channels: 2, seconds: 10, sampleRate: 44100, convert: true };
  const mp3 = () => {
    const file = new File(['x'], 'talk.mp3', { type: 'audio/mpeg' });
    Object.defineProperty(file, 'size', { value: 100 * 1000 });
    return file;
  };
  const radio = (label) =>
    all(document.body, 'label')
      .find((l) => l.textContent.includes(label))
      ?.querySelector('input');

  it('uploads a recording that is not a WAV as a WAV of its channels, at the quality chosen', async () => {
    const onUpload = vi.fn();
    const file = mp3();
    const wav = new File(['w'], 'talk.wav', { type: 'audio/wav' });
    const makeWav = vi.fn(async () => wav);
    view = await renderComponent(
      <ChannelSpeakersDialog
        open
        file={file}
        onOpenChange={() => {}}
        onUpload={onUpload}
        readFile={async () => mp3Read}
        makeWav={makeWav}
      />,
    );
    await settled();
    expect(text()).toContain('2 channels');
    expect(text()).toContain('Uploaded as a WAV.');
    expect(text()).toContain('Full quality (44.1 kHz)· 1.8 MB');
    expect(text()).toContain('Smaller (16 kHz)· 640 KB');
    await type(field('Channel 1 speaker'), 'Ana');
    await type(field('Channel 2 speaker'), 'Ben');
    await view.step(() => radio('Smaller').click());
    await view.step(() => button('Upload').click());
    await settled();
    expect(makeWav).toHaveBeenCalledTimes(1);
    expect(makeWav.mock.calls[0][0]).toMatchObject({ ...mp3Read, file });
    expect(makeWav.mock.calls[0][1]).toMatchObject({ quality: 'small' });
    expect(onUpload).toHaveBeenCalledWith(wav, { channelSpeakers: ['Ana', 'Ben'] });
  });

  it('checks the WAV against the server limit, not the file chosen', async () => {
    const onUpload = vi.fn();
    view = await renderComponent(
      <ChannelSpeakersDialog
        open
        file={mp3()}
        onOpenChange={() => {}}
        onUpload={onUpload}
        maxBytes={1000 * 1000}
        readFile={async () => mp3Read}
        makeWav={async () => null}
      />,
    );
    await settled();
    expect(text()).toContain('This server accepts 1.0 MB. The WAV is 1.8 MB.');
    expect(button('Upload').disabled).toBe(true);
    await view.step(() => radio('Smaller').click());
    expect(text()).not.toContain('This server accepts');
    expect(button('Upload').disabled).toBe(false);
  });

  it('asks no quality for a WAV', async () => {
    await mount(2);
    expect(text()).not.toContain('Full quality');
    expect(text()).not.toContain('Uploaded as a WAV.');
  });
});
