import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertedNote, prepareRecording, prepareRecordings } from './playableRecording.js';

const fixture = (name, as = name) =>
  new File(
    [readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'adpcm-fixtures', name))],
    as,
    { type: 'audio/wav' },
  );

describe('prepareRecording', () => {
  it('passes a PCM WAV through untouched, without asking the browser', async () => {
    const file = fixture('pcm.wav');
    const asked = [];
    const ready = await prepareRecording(file, { canPlay: async (f) => asked.push(f) && false });
    expect(ready).toEqual({ file, convertedFrom: null });
    expect(asked).toEqual([]);
  });

  it('decodes an ADPCM WAV to a PCM WAV of the same name', async () => {
    const ready = await prepareRecording(fixture('ima-stereo-ext.wav', 'talk.WAV'));
    expect(ready.convertedFrom).toBe('IMA ADPCM');
    expect(ready.file.name).toBe('talk.WAV');
    expect(ready.file.type).toBe('audio/wav');
    expect(ready.file.size).toBe(fixture('ima-stereo.ref.wav').size);
  });

  it('refuses a WAV coding it cannot decode, by file name and coding', async () => {
    expect(await prepareRecording(fixture('gsm.wav', 'call.wav'))).toEqual({
      refused: 'call.wav cannot be played in a browser (GSM 6.10 WAV).',
    });
  });

  it('refuses an ADPCM WAV it cannot convert, as when the file cannot be read', async () => {
    const adpcm = fixture('ima-mono.wav', 'long.wav');
    const unreadable = new File([adpcm], 'long.wav', { type: 'audio/wav' });
    unreadable.arrayBuffer = async () => {
      throw new RangeError('Array buffer allocation failed');
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await prepareRecording(unreadable)).toEqual({
      refused: 'long.wav could not be converted to PCM WAV.',
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('asks the browser about anything else', async () => {
    const amr = new File(['#!AMR\n'], 'note.amr', { type: 'audio/amr' });
    expect(await prepareRecording(amr, { canPlay: async () => false })).toEqual({
      refused: 'note.amr cannot be played in this browser.',
    });
    expect(await prepareRecording(amr, { canPlay: async () => true })).toEqual({
      file: amr,
      convertedFrom: null,
    });
  });
});

describe('prepareRecordings', () => {
  it('keeps the order, swaps the converted, drops the refused', async () => {
    const pcm = fixture('pcm.wav', 'a.wav');
    const out = await prepareRecordings([
      pcm,
      fixture('g721.wav', 'b.wav'),
      fixture('ms-mono.wav', 'c.wav'),
    ]);
    expect(out.files.map((f) => f.name)).toEqual(['a.wav', 'c.wav']);
    expect(out.files[0]).toBe(pcm);
    expect(out.converted).toEqual([{ name: 'c.wav', from: 'MS ADPCM' }]);
    expect(out.refused).toEqual(['b.wav cannot be played in a browser (G.721 ADPCM WAV).']);
    expect(convertedNote(out.converted)).toBe('Converted c.wav from MS ADPCM to PCM WAV.');
    expect(convertedNote([...out.converted, { name: 'd.wav', from: 'IMA ADPCM' }])).toBe(
      'Converted 2 recordings to PCM WAV.',
    );
    expect(convertedNote([])).toBeNull();
  });
});
