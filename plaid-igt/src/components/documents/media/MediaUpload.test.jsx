import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { MediaUpload } from './MediaUpload.jsx';
import { notifyError, notifyInfo } from '@/utils/feedback';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The screen as the decode found it: the decode holds the tab, so what it
// sees is what the person sees while it runs.
const decode = vi.hoisted(() => ({ screen: null, bar: null, container: null }));
vi.mock('@/domain/media/wavAdpcm.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    adpcmWavToPcm: (...args) => {
      decode.screen = decode.container?.textContent ?? null;
      decode.bar = decode.container?.querySelector('[role="progressbar"]') ?? null;
      return real.adpcmWavToPcm(...args);
    },
  };
});
vi.mock('@/utils/feedback', () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
}));

const fixtureFile = (name, as = name) =>
  new File(
    [
      readFileSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../../domain/media/adpcm-fixtures',
          name,
        ),
      ),
    ],
    as,
    { type: 'audio/wav' },
  );

// The upload card shows the upload: the bytes as a bar with a count while
// they go up, then a pulsing bar while the server checks and saves the file.

const bar = (container) => container.querySelector('[role="progressbar"]');
const buttonSaying = (root, text) =>
  all(root, 'button').find((b) => b.textContent.includes(text)) ?? null;

// Choosing a file is what the picker's change event carries.
const choose = async (r, file) => {
  const input = r.container.querySelector('input[type=file]');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await r.step(() => input.dispatchEvent(new Event('change', { bubbles: true })));
};
const fileOf = (size, name = 'rec.mp4', type = 'video/mp4') => {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};
const MB = 1000 * 1000;
// A conversion lets the screen paint before it starts, so its outcome comes a
// frame or more after the choice.
const until = (r, done) =>
  r.step(async () => {
    for (let i = 0; i < 100 && !done(); i += 1) await new Promise((ok) => setTimeout(ok, 5));
  });

describe('MediaUpload', () => {
  it('offers the file picker when nothing is uploading', async () => {
    const r = await renderComponent(<MediaUpload onUpload={vi.fn()} isUploading={false} />);
    expect(all(r.container, 'button')).toHaveLength(3);
    expect(bar(r.container)).toBeNull();
    await r.unmount();
  });

  it('uploads a small file on sight, with nothing to decide', async () => {
    const onUpload = vi.fn();
    const r = await renderComponent(<MediaUpload onUpload={onUpload} isUploading={false} />);
    const file = fileOf(2 * MB);
    await choose(r, file);
    expect(onUpload).toHaveBeenCalledWith(file);
    await r.unmount();
  });

  it('asks about a large file instead of sending it', async () => {
    const onUpload = vi.fn();
    const r = await renderComponent(<MediaUpload onUpload={onUpload} isUploading={false} />);
    await choose(r, fileOf(120 * MB));
    expect(onUpload).not.toHaveBeenCalled();
    expect(buttonSaying(r.container, 'Convert to')).toBeTruthy();
    expect(buttonSaying(r.container, 'Upload as it is')?.disabled).toBe(false);
    await r.unmount();
  });

  it('refuses to send one the server would reject, leaving only the conversion', async () => {
    const onUpload = vi.fn();
    const r = await renderComponent(
      <MediaUpload onUpload={onUpload} isUploading={false} maxBytes={100 * MB} />,
    );
    await choose(r, fileOf(300 * MB));
    expect(r.container.textContent).toContain('This server accepts 100 MB');
    expect(buttonSaying(r.container, 'Upload as it is').disabled).toBe(true);
    await r.step(() => buttonSaying(r.container, 'Convert to').click());
    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onUpload.mock.calls[0][1]).toEqual({ convert: true });
    await r.unmount();
  });

  it('a file just over the limit shows the decimal that puts it over', async () => {
    const r = await renderComponent(
      <MediaUpload onUpload={vi.fn()} isUploading={false} maxBytes={100 * MB} />,
    );
    await choose(r, fileOf(100.4 * MB));
    expect(r.container.textContent).toContain('· 100.4 MB');
    expect(r.container.textContent).toContain('This server accepts 100.0 MB');
    await r.unmount();
  });

  it('sends a merely large file as it is when that is chosen', async () => {
    const onUpload = vi.fn();
    const r = await renderComponent(
      <MediaUpload onUpload={onUpload} isUploading={false} maxBytes={500 * MB} />,
    );
    await choose(r, fileOf(120 * MB));
    await r.step(() => buttonSaying(r.container, 'Upload as it is').click());
    expect(onUpload.mock.calls[0][1]).toEqual({ convert: false });
    await r.unmount();
  });

  it('says what conversion costs, and mentions the picture only when there is one', async () => {
    const r = await renderComponent(<MediaUpload onUpload={vi.fn()} isUploading={false} />);
    await choose(r, fileOf(120 * MB));
    expect(r.container.textContent).toContain('too coarse for phonetic measurement');
    expect(r.container.textContent).toContain('without the picture');
    await r.unmount();

    const audio = await renderComponent(<MediaUpload onUpload={vi.fn()} isUploading={false} />);
    await choose(audio, fileOf(120 * MB, 'rec.wav', 'audio/wav'));
    expect(audio.container.textContent).not.toContain('without the picture');
    await audio.unmount();
  });

  it('sends an ADPCM WAV as PCM, of the same name, and says so in one line', async () => {
    notifyInfo.mockClear();
    const onUpload = vi.fn();
    const r = await renderComponent(<MediaUpload onUpload={onUpload} isUploading={false} />);
    await choose(r, fixtureFile('ima-mono.wav', 'story.wav'));
    await until(r, () => onUpload.mock.calls.length > 0);
    expect(onUpload).toHaveBeenCalledTimes(1);
    const sent = onUpload.mock.calls[0][0];
    expect(sent.name).toBe('story.wav');
    const bytes = new Uint8Array(await sent.arrayBuffer());
    // A PCM WAV with libsndfile's samples.
    expect(new DataView(bytes.buffer).getUint16(20, true)).toBe(1);
    expect(bytes.length).toBe(fixtureFile('ima-mono.ref.wav').size);
    expect(notifyInfo).toHaveBeenCalledWith('Converted story.wav from IMA ADPCM to PCM WAV.');
    await r.unmount();
  });

  it('shows the conversion running before the tab is held by it', async () => {
    const onUpload = vi.fn();
    const r = await renderComponent(<MediaUpload onUpload={onUpload} isUploading={false} />);
    decode.container = r.container;
    decode.screen = null;
    await choose(r, fixtureFile('ima-mono.wav', 'story.wav'));
    await until(r, () => onUpload.mock.calls.length > 0);
    expect(decode.screen).toContain('Converting to PCM WAV.');
    expect(decode.screen).toContain('story.wav');
    expect(decode.bar).toBeTruthy();
    expect(decode.bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(r.container.textContent).not.toContain('Converting to PCM WAV.');
    await r.unmount();
  });

  it('weighs the converted file against the limit, not the original', async () => {
    const onUpload = vi.fn();
    const original = fixtureFile('ms-mono.wav');
    const r = await renderComponent(
      <MediaUpload onUpload={onUpload} isUploading={false} maxBytes={original.size + 100} />,
    );
    await choose(r, original);
    await until(r, () => buttonSaying(r.container, 'Upload as it is'));
    expect(onUpload).not.toHaveBeenCalled();
    expect(buttonSaying(r.container, 'Upload as it is').disabled).toBe(true);
    await r.unmount();
  });

  it('refuses a WAV coding it cannot convert, naming the file, and sends nothing', async () => {
    notifyError.mockClear();
    const onUpload = vi.fn();
    const r = await renderComponent(<MediaUpload onUpload={onUpload} isUploading={false} />);
    await choose(r, fixtureFile('gsm.wav', 'phone.wav'));
    expect(onUpload).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      'phone.wav cannot be played in a browser (GSM 6.10 WAV).',
    );
    await r.unmount();
  });

  it('refuses any other file this browser cannot play', async () => {
    notifyError.mockClear();
    const onUpload = vi.fn();
    const r = await renderComponent(
      <MediaUpload
        onUpload={onUpload}
        isUploading={false}
        prepareOptions={{ canPlay: async () => false }}
      />,
    );
    await choose(r, fileOf(2 * MB, 'interview.amr', 'audio/amr'));
    expect(onUpload).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith('interview.amr cannot be played in this browser.');
    await r.unmount();
  });

  it('shows the conversion running, not the upload', async () => {
    const r = await renderComponent(
      <MediaUpload
        onUpload={vi.fn()}
        isUploading={false}
        convertProgress={{ name: 'rec.mp4', fraction: 0.5 }}
      />,
    );
    expect(r.container.textContent).toContain('Converting to MP3');
    expect(bar(r.container)).toBeTruthy();
    await r.unmount();
  });

  it('shows the file, the percentage and the byte count while the bytes go up', async () => {
    const r = await renderComponent(
      <MediaUpload
        onUpload={vi.fn()}
        isUploading
        progress={{ name: 'talk.wav', loaded: 250, total: 1000 }}
      />,
    );
    expect(all(r.container, 'button')).toHaveLength(0);
    expect(r.container.textContent).toContain('talk.wav');
    expect(r.container.textContent).toContain('25%');
    expect(r.container.textContent).toContain('250 bytes of 1.0 KB');
    expect(bar(r.container).getAttribute('aria-valuenow')).toBe('25');
    await r.unmount();
  });

  // An upload whose answer was lost goes again from the first byte, until the
  // server answers (H7-3). The card says so, in the words the save pills use,
  // rather than a bar that silently starts over.
  it('says it cannot reach the server while the upload is being sent again', async () => {
    const saves = (offline) => ({
      isSaving: true,
      isOffline: offline,
      subscribe: () => () => {},
      getSnapshot: () => (offline ? 1 : 0),
    });
    const card = (offline) => (
      <MediaUpload
        onUpload={vi.fn()}
        isUploading
        progress={{ name: 'talk.wav', loaded: 250, total: 1000 }}
        saves={saves(offline)}
      />
    );
    const r = await renderComponent(card(false));
    expect(r.container.textContent).not.toContain('retrying');
    await r.rerender(card(true));
    expect(r.container.textContent).toContain("Can't reach the server, retrying");
    await r.unmount();
  });

  it('pulses without a number once every byte is up and the server is at work', async () => {
    const r = await renderComponent(
      <MediaUpload
        onUpload={vi.fn()}
        isUploading
        progress={{ name: 'talk.wav', loaded: 1000, total: 1000 }}
      />,
    );
    expect(r.container.textContent).toContain('Processing…');
    expect(r.container.textContent).not.toContain('100%');
    expect(bar(r.container).hasAttribute('aria-valuenow')).toBe(false);
    await r.unmount();
  });

  // Cancel stops an upload while its bytes go up. Once every byte is up the
  // server stores the file whatever the browser does, so Cancel is not on the
  // card then.
  it('offers Cancel while the bytes go up, and not once every byte is up', async () => {
    const onCancel = vi.fn();
    const card = (loaded) => (
      <MediaUpload
        onUpload={vi.fn()}
        onCancel={onCancel}
        isUploading
        progress={{ name: 'talk.wav', loaded, total: 1000 }}
      />
    );
    const r = await renderComponent(card(250));
    const cancel = buttonSaying(r.container, 'Cancel');
    expect(cancel.disabled).toBe(false);
    await r.step(() => cancel.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    await r.rerender(card(1000));
    expect(buttonSaying(r.container, 'Cancel')).toBeFalsy();
    expect(r.container.textContent).toContain('Processing…');
    await r.unmount();
  });

  it('is back on the mode it had once an upload is cancelled', async () => {
    const card = (progress) => (
      <MediaUpload
        onUpload={vi.fn()}
        onCancel={vi.fn()}
        isUploading={!!progress}
        progress={progress}
      />
    );
    const r = await renderComponent(card(null));
    await r.step(() =>
      all(r.container, 'button')
        .find((b) => b.textContent === 'Per speaker')
        .click(),
    );
    await r.rerender(card({ name: 'talk.wav', loaded: 250, total: 1000 }));
    await r.rerender(card(null));
    expect(
      all(r.container, 'button')
        .find((b) => b.textContent === 'Per speaker')
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(buttonSaying(r.container, 'Choose media files').disabled).toBe(false);
    await r.unmount();
  });

  it('puts focus on the file picker button once an upload is cancelled', async () => {
    const card = (progress) => (
      <MediaUpload
        onUpload={vi.fn()}
        onCancel={vi.fn()}
        isUploading={!!progress}
        progress={progress}
      />
    );
    const r = await renderComponent(card({ name: 'talk.wav', loaded: 250, total: 1000 }));
    await r.step(() => buttonSaying(r.container, 'Cancel').click());
    await r.rerender(card(null));
    expect(document.activeElement).toBe(buttonSaying(r.container, 'Choose media file'));
    await r.unmount();
  });

  // A card mounted while a Per speaker upload goes (the tab left and come
  // back to) shows the bar, and is on Per speaker once it is cancelled.
  it('mounted during a Per speaker upload, is on Per speaker once it is cancelled', async () => {
    const card = (progress) => (
      <MediaUpload
        onUpload={vi.fn()}
        onCancel={vi.fn()}
        isUploading={!!progress}
        progress={progress}
      />
    );
    const r = await renderComponent(
      card({ name: 'talk.wav', loaded: 250, total: 1000, perSpeaker: true }),
    );
    expect(r.container.textContent).toContain('25%');
    expect(buttonSaying(r.container, 'Cancel')).not.toBeNull();
    await r.rerender(card(null));
    expect(
      all(r.container, 'button')
        .find((b) => b.textContent === 'Per speaker')
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(buttonSaying(r.container, 'Choose media files').disabled).toBe(false);
    await r.unmount();
  });

  // The card has two modes, Single (the default) and Per speaker. Single
  // takes one file, and several are refused with a note naming the switch.
  // Per speaker takes several files, mixed in the mix dialog, or one file
  // with a channel per speaker, whose speakers are asked in their own dialog.
  const chooseAll = async (r, files) => {
    const input = r.container.querySelector('input[type=file]');
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await r.step(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  };
  const decodeTrack = async (file) => ({
    name: file.name,
    sampleRate: 16000,
    channels: 1,
    seconds: 1,
    mono: new Float32Array(16000),
  });
  const two = () => [
    fileOf(2 * MB, 'ana.wav', 'audio/wav'),
    fileOf(2 * MB, 'ben.wav', 'audio/wav'),
  ];
  const perSpeaker = (r) =>
    r.step(() =>
      all(r.container, 'button')
        .find((b) => b.textContent === 'Per speaker')
        .click(),
    );
  const pressed = (r, label) =>
    all(r.container, 'button')
      .find((b) => b.textContent === label)
      .getAttribute('aria-pressed');

  it('starts on Single, which takes one file', async () => {
    const r = await renderComponent(<MediaUpload onUpload={vi.fn()} isUploading={false} />);
    expect(pressed(r, 'Single')).toBe('true');
    expect(pressed(r, 'Per speaker')).toBe('false');
    expect(r.container.querySelector('input[type=file]').multiple).toBe(false);
    expect(buttonSaying(r.container, 'Choose media file')).not.toBeNull();
    expect(r.container.textContent).toContain('One audio or video file.');
    expect(r.container.textContent).not.toContain('Mix files');
    await r.unmount();
  });

  it('several files on Single are refused with a note naming the switch', async () => {
    const onUpload = vi.fn();
    const r = await renderComponent(
      <MediaUpload onUpload={onUpload} isUploading={false} decodeTrack={decodeTrack} />,
    );
    await chooseAll(r, two());
    await until(r, () => r.container.textContent.includes('One file at a time'));
    expect(r.container.textContent).toContain(
      'One file at a time. For a file per speaker, switch to Per speaker.',
    );
    expect(onUpload).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Mix recordings');
    await r.unmount();
  });

  it('several files dropped on Single are refused the same way', async () => {
    const onUpload = vi.fn();
    const r = await renderComponent(<MediaUpload onUpload={onUpload} isUploading={false} />);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = { files: two() };
    await r.step(() => r.container.firstChild.dispatchEvent(drop));
    await until(r, () => r.container.textContent.includes('One file at a time'));
    expect(onUpload).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Mix recordings');
    await r.unmount();
  });

  it('Per speaker says what it does, and its picker takes several files', async () => {
    const r = await renderComponent(<MediaUpload onUpload={vi.fn()} isUploading={false} />);
    await perSpeaker(r);
    expect(pressed(r, 'Per speaker')).toBe('true');
    expect(r.container.querySelector('input[type=file]').multiple).toBe(true);
    expect(r.container.textContent).toContain('Upload media files');
    expect(r.container.textContent).toContain(
      'One file per speaker, or one file with a channel per speaker.',
    );
    expect(buttonSaying(r.container, 'Choose media files')).not.toBeNull();
    await r.unmount();
  });

  it('several files on Per speaker open the mix dialog', async () => {
    const onUpload = vi.fn();
    const r = await renderComponent(
      <MediaUpload onUpload={onUpload} isUploading={false} decodeTrack={decodeTrack} />,
    );
    await perSpeaker(r);
    await chooseAll(r, two());
    await until(r, () => document.body.textContent.includes('ben.wav'));
    expect(onUpload).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Mix recordings');
    expect(document.body.textContent).toContain('ana.wav');
    await r.unmount();
  });

  it('one file on Per speaker asks a speaker per channel, with no mix', async () => {
    const onUpload = vi.fn();
    const r = await renderComponent(
      <MediaUpload
        onUpload={onUpload}
        isUploading={false}
        readFile={async () => ({ channels: 2, convert: false })}
      />,
    );
    await perSpeaker(r);
    await chooseAll(r, [fileOf(2 * MB, 'interview.wav', 'audio/wav')]);
    await until(r, () => document.body.textContent.includes('Channel 2'));
    expect(document.body.textContent).toContain('Speakers per channel');
    expect(document.body.textContent).not.toContain('Mix recordings');
    expect(onUpload).not.toHaveBeenCalled();
    await r.unmount();
  });

  // A video goes up under Single only. Its type says it is one, whatever its
  // tracks: an audio-only .webm typed as video is refused too.
  it('one video on Per speaker is refused with a note naming the switch, before any dialog', async () => {
    const onUpload = vi.fn();
    const readFile = vi.fn(async () => ({ channels: 2, convert: false }));
    const r = await renderComponent(
      <MediaUpload onUpload={onUpload} isUploading={false} readFile={readFile} />,
    );
    await perSpeaker(r);
    for (const video of [fileOf(2 * MB), fileOf(2 * MB, 'voice.webm', 'video/webm')]) {
      await chooseAll(r, [video]);
      await until(r, () => r.container.textContent.includes('Switch to Single'));
      expect(r.container.textContent).toContain(
        'A video cannot be split by speaker. Switch to Single.',
      );
    }
    expect(document.body.textContent).not.toContain('Speakers per channel');
    expect(readFile).not.toHaveBeenCalled();
    expect(onUpload).not.toHaveBeenCalled();
    await r.step(() => buttonSaying(r.container, 'Single').click());
    expect(r.container.textContent).not.toContain('Switch to Single');
    await r.unmount();
  });

  it('files dropped on the card are chosen like picked ones', async () => {
    const onUpload = vi.fn();
    const r = await renderComponent(<MediaUpload onUpload={onUpload} isUploading={false} />);
    const file = fileOf(2 * MB);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = { files: [file] };
    await r.step(() => r.container.firstChild.dispatchEvent(drop));
    await until(r, () => onUpload.mock.calls.length > 0);
    expect(onUpload).toHaveBeenCalledWith(file);
    await r.unmount();
  });
});
