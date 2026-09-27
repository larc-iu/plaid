import { describe, it, expect } from 'vitest';
import { decodeText, readTextFile, NotUtf8FileError } from './textFile.js';

const utf16le = (s, bom = true) => {
  const out = bom ? [0xff, 0xfe] : [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8);
  return new Uint8Array(out);
};
const utf16be = (s) => {
  const out = [0xfe, 0xff];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) >> 8, s.charCodeAt(i) & 0xff);
  return new Uint8Array(out);
};
const utf8 = (s) => new TextEncoder().encode(s);
const MESSAGE = 'This file is not UTF-8. Save it as UTF-8 and import it again.';

describe('decodeText', () => {
  it('reads UTF-8, with or without its byte order mark', () => {
    expect(decodeText(utf8('kai tát \u{10330}'))).toBe('kai tát \u{10330}');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('kai')]))).toBe('kai');
    expect(decodeText(new Uint8Array([]))).toBe('');
  });

  it('reads UTF-16 by its byte order mark, either byte order', () => {
    const s = '# text = kai tát \u{1F600}\n1\tkai';
    expect(decodeText(utf16le(s))).toBe(s);
    expect(decodeText(utf16be(s))).toBe(s);
  });

  it('refuses UTF-16 with no byte order mark', () => {
    expect(() => decodeText(utf16le('kai tat', false))).toThrow(NotUtf8FileError);
    expect(() => decodeText(utf16le('kai tat', false))).toThrow(MESSAGE);
  });

  it('refuses any NUL, and names the file when told it', () => {
    expect(() => decodeText(utf8('kai\u0000'), 'words.tsv')).toThrow(
      'words.tsv is not UTF-8. Save it as UTF-8 and import it again.',
    );
  });

  it('refuses a byte the encoding cannot hold only when fatal', () => {
    // "café" in cp1252: 0xE9 is not UTF-8.
    const cp1252 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeText(cp1252)).toBe('caf\uFFFD');
    expect(() => decodeText(cp1252, 'w.csv', { fatal: true })).toThrow(
      'w.csv is not UTF-8. Save it as UTF-8 and import it again.',
    );
    expect(decodeText(utf16le('kai'), null, { fatal: true })).toBe('kai');
  });

  it('takes an ArrayBuffer as well as bytes', () => {
    expect(decodeText(utf8('kai').buffer)).toBe('kai');
  });
});

describe('readTextFile', () => {
  it('reads a picked file through the same checks', async () => {
    const file = new File([utf16le('kai')], 'a.conllu');
    expect(await readTextFile(file)).toBe('kai');
    await expect(readTextFile(new File([utf16le('kai', false)], 'b.conllu'))).rejects.toThrow(
      MESSAGE,
    );
  });
});
