import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MAX_BYTES,
  NotUtf8Error,
  chunk,
  convOfFileKey,
  lineCount,
  readAttachment,
  refOf,
  refuse,
  resetSweep,
  storedBytes,
  sweepOrphanFiles,
  uploadAttachments,
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

const store = (over = {}) => {
  const records = new Map(Object.entries(over.records || {}));
  return {
    records,
    store: {
      userId: 'u1',
      app: 'igt',
      projectId: 'p1',
      client: {
        userData: {
          put: vi.fn(async (userId, key, value) => records.set(key, value)),
          delete: vi.fn(async (userId, key) => records.delete(key)),
          list: vi.fn(async (userId, { prefix }) =>
            [...records.entries()]
              .filter(([key]) => key.startsWith(prefix))
              .map(([key, v]) => ({ key, updatedAt: v.updatedAt })),
          ),
        },
      },
    },
  };
};

beforeEach(() => resetSweep());

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
    expect(refuse({ name: 'photo.png', size: 10 })).toContain('It reads text');
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

  it('counts the lines a person would, and not a last empty one', () => {
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a\nb')).toBe(2);
    expect(lineCount('')).toBe(0);
  });
});

describe('storing a file', () => {
  it('writes every part under the conversation, and the message carries only the reference', async () => {
    const { records, store: s } = store();
    const file = fileOf('wordlist.csv', 'хьун,вода\n'.repeat(400));
    const pending = await readAttachment(file, 1500);
    expect(pending.parts.length).toBeGreaterThan(1);
    await uploadAttachments(s, 'c1', [pending]);
    const keys = [...records.keys()];
    expect(keys).toEqual(
      pending.parts.map((_, n) => `igt:assistant:p1:file:c1:${pending.id}:part:${n}`),
    );
    expect(keys.map((k) => records.get(k)).join('')).toBe('хьун,вода\n'.repeat(400));
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

  it('reads the conversation off a file key', () => {
    expect(convOfFileKey('igt', 'p1', 'igt:assistant:p1:file:c9:f1:part:0')).toBe('c9');
    expect(convOfFileKey('igt', 'p1', 'igt:assistant:p2:file:c9:f1:part:0')).toBeNull();
  });
});

describe('sweepOrphanFiles', () => {
  const OLD = '2020-01-01T00:00:00Z';

  it('deletes an old file whose conversation is gone, and nothing else', async () => {
    const { records, store: s } = store({
      records: {
        'igt:assistant:p1:file:live:f1:part:0': { updatedAt: OLD },
        'igt:assistant:p1:file:gone:f2:part:0': { updatedAt: OLD },
        'igt:assistant:p1:file:fresh:f3:part:0': { updatedAt: new Date().toISOString() },
      },
    });
    expect(await sweepOrphanFiles(s, ['live'])).toBe(1);
    expect([...records.keys()].sort()).toEqual([
      'igt:assistant:p1:file:fresh:f3:part:0',
      'igt:assistant:p1:file:live:f1:part:0',
    ]);
  });

  it('runs once a page load, per project', async () => {
    const { store: s } = store();
    await sweepOrphanFiles(s, []);
    await sweepOrphanFiles(s, []);
    expect(s.client.userData.list).toHaveBeenCalledTimes(1);
  });
});
