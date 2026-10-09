import { describe, it, expect, vi } from 'vitest';
import {
  MAX_BYTES,
  NotUtf8Error,
  chunk,
  lineCount,
  blobOf,
  readAttachment,
  readStoredFile,
  refOf,
  refuse,
  storedBytes,
} from './attachments.js';

// What an attached file becomes on its way to the store. The measure has to be
// the SERVER's, or a file that looks small enough is refused with a 413 on
// send; the parts have to join back to exactly the text; and the sweep must
// never take a file that belongs to a conversation it simply failed to see.

// The server's own count: clojure.data.json escapes non-ASCII as \uXXXX and
// "/" as \/. This is the same arithmetic plaid_agent/core/conversation.py
// `_bytes` does, written out the long way so the two can be checked against it.
// A picked file, as the browser hands one over: bytes, not a string. The
// decode is the reader's, which is the point of the test below.
const fileOf = (name, text) => ({
  name,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer,
});

const bytesFile = (name, bytes) => ({
  name,
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
});

const serverBytes = (s) => {
  const json = JSON.stringify(s)
    .replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/\//g, '\\/');
  return new TextEncoder().encode(json).length;
};

describe('storedBytes', () => {
  it.each([
    ['ascii', 'word,translation\nnis,milk\n'],
    ['a slash and quotes', 'a/b,"c"\\d'],
    ['Cyrillic', 'хьун,вода\n'],
    ['a character past the BMP', 'x\u{1F600}y'],
    ['a control character', 'a\u0001b\tc'],
  ])('counts %s the way the server does', (_, text) => {
    expect(storedBytes(text)).toBe(serverBytes(text));
  });
});

describe('chunk', () => {
  it('cuts into parts that each fit, and that join back to the text', () => {
    const text = 'хьун,вода\n'.repeat(500) + 'plain,ascii\n'.repeat(500);
    const parts = chunk(text, 2000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(text);
    for (const p of parts) expect(storedBytes(p)).toBeLessThanOrEqual(2000);
  });

  it('never cuts a surrogate pair in half', () => {
    const text = '\u{1F600}'.repeat(200);
    const parts = chunk(text, 50);
    expect(parts.join('')).toBe(text);
    for (const p of parts) {
      expect(p.charCodeAt(p.length - 1) >= 0xd800 && p.charCodeAt(p.length - 1) <= 0xdbff).toBe(
        false,
      );
    }
  });

  it('keeps an empty file as one empty part', () => {
    expect(chunk('', 100)).toEqual(['']);
  });
});

describe('what may be attached', () => {
  it('reads text and refuses what it cannot, naming the remedy', () => {
    expect(refuse({ name: 'wordlist.csv', size: 10 })).toBeNull();
    expect(refuse({ name: 'story.flextext', size: 10 })).toBeNull();
    expect(refuse({ name: 'photo.png', size: 10 })).toContain('It reads .csv');
    expect(refuse({ name: 'photo.png', size: 10 })).toContain('.pdf');
    expect(refuse({ name: 'corpus.csv', size: MAX_BYTES + 1 })).toContain('import screen');
  });

  // Excel on Windows writes cp1252 unless "CSV UTF-8" is picked. Decoded
  // leniently, 0xE9 is U+FFFD and nothing on screen says so.
  it('refuses a file that is not UTF-8, by name', async () => {
    // "café\n" in cp1252: the 0xE9 is not a valid UTF-8 sequence.
    const file = bytesFile('wordlist.csv', [0x63, 0x61, 0x66, 0xe9, 0x0a]);
    await expect(readAttachment(file)).rejects.toBeInstanceOf(NotUtf8Error);
    await expect(readAttachment(file)).rejects.toThrow(/wordlist\.csv is not UTF-8 text/);
  });

  it('reads a UTF-8 file with a BOM as its text, without the mark', async () => {
    const withBom = {
      name: 'w.csv',
      arrayBuffer: async () =>
        new Uint8Array([0xef, 0xbb, 0xbf, 0x63, 0x61, 0x66, 0xc3, 0xa9]).buffer,
    };
    const pending = await readAttachment(withBom);
    expect(pending.text).toBe('café');
  });

  // Windows "Unicode text" is UTF-16. With its byte order mark it is read as
  // what it is. Without one every ASCII letter is followed by a NUL byte,
  // which is valid UTF-8 and would reach the service as text full of NULs.
  it('reads a UTF-16 file by its byte order mark', async () => {
    const file = bytesFile('w.txt', [0xff, 0xfe, 0x63, 0, 0x61, 0, 0x66, 0, 0xe9, 0]);
    expect((await readAttachment(file)).text).toBe('café');
  });

  it('refuses UTF-16 with no byte order mark, and any NUL, by name', async () => {
    const noMark = bytesFile('w.txt', [0x6b, 0, 0x61, 0, 0x69, 0, 0x0a, 0]);
    await expect(readAttachment(noMark)).rejects.toBeInstanceOf(NotUtf8Error);
    await expect(readAttachment(noMark)).rejects.toThrow(
      'w.txt is not UTF-8 text. Save it as UTF-8 and attach it again.',
    );
    const nul = bytesFile('n.csv', [0x61, 0, 0x0a]);
    await expect(readAttachment(nul)).rejects.toThrow(/n\.csv is not UTF-8 text/);
  });

  it('counts the lines a person would, and not a last empty one', () => {
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a\nb')).toBe(2);
    expect(lineCount('')).toBe(0);
  });
});

describe('what a message carries of a file', () => {
  it('is the reference alone, and the parts the service stores join back to the text', async () => {
    const file = fileOf('wordlist.csv', 'хьун,вода\n'.repeat(400));
    const pending = await readAttachment(file, 1500);
    expect(pending.parts.length).toBeGreaterThan(1);
    expect(pending.parts.join('')).toBe('хьун,вода\n'.repeat(400));
    const ref = refOf(pending);
    expect(ref).toEqual({
      id: pending.id,
      name: 'wordlist.csv',
      bytes: pending.bytes,
      lines: 400,
      chunks: pending.parts.length,
    });
    expect(JSON.stringify(ref)).not.toContain('вода');
  });
});

describe('a file a reply made', () => {
  const store = (values) => ({
    app: 'igt',
    projectId: 'p1',
    userId: 'u@x',
    client: {
      // The real client rejects a missing key with a 404.
      userData: {
        get: vi.fn(async (_, key) => {
          if (key in values) return { value: values[key] };
          throw Object.assign(new Error('No such entry'), { status: 404 });
        }),
      },
    },
  });
  const key = (n) => `igt:assistant:p1:file:c1:f1:part:${n}`;

  it('is read back whole from its parts, in order', async () => {
    const s = store({ [key(0)]: 'form,meaning\n', [key(1)]: 'a,b\n' });
    const text = await readStoredFile(s, 'c1', { id: 'f1', name: 'w.csv', chunks: 2 });
    expect(text).toBe('form,meaning\na,b\n');
  });

  it('says so when a part is gone', async () => {
    const s = store({ [key(0)]: 'x' });
    await expect(readStoredFile(s, 'c1', { id: 'f1', name: 'w.csv', chunks: 2 })).rejects.toThrow(
      /w\.csv is no longer stored/,
    );
  });

  it('is saved with a byte-order mark when it is a table, so Excel reads it as UTF-8', async () => {
    expect(await blobOf('w.csv', 'a').text()).toBe('\uFEFFa');
    expect(blobOf('w.csv', 'a').type).toBe('text/csv;charset=utf-8');
    expect(await blobOf('notes.md', 'a').text()).toBe('a');
  });
});
