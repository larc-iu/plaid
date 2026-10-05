import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { MediaUpload } from './MediaUpload.jsx';
import { notifyError, notifyInfo } from '@/utils/feedback';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

describe('MediaUpload', () => {
  it('offers the file picker when nothing is uploading', async () => {
    const r = await renderComponent(<MediaUpload onUpload={vi.fn()} isUploading={false} />);
    expect(all(r.container, 'button')).toHaveLength(1);
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

  it('weighs the converted file against the limit, not the original', async () => {
    const onUpload = vi.fn();
    const original = fixtureFile('ms-mono.wav');
    const r = await renderComponent(
      <MediaUpload onUpload={onUpload} isUploading={false} maxBytes={original.size + 100} />,
    );
    await choose(r, original);
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
});
