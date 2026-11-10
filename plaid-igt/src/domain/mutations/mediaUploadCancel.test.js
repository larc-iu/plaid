import { describe, it, expect, beforeEach } from 'vitest';
import { buildRawDoc, resetIds, makeIgtDoc } from '../test-helpers.js';

// An upload the person cancels: the client's upload is handed the signal, a
// cancelled upload is neither refused nor reported, writes no speakers per
// channel, and the document is read again so it shows what the server holds.

beforeEach(() => resetIds());

const kinds = (doc) => doc.client.calls.map((c) => c.kind);

describe('uploadMedia with a signal', () => {
  it('hands the signal to the client', async () => {
    const doc = makeIgtDoc({ raw: buildRawDoc() });
    const abort = new AbortController();
    expect(await doc.uploadMedia(new Blob(['x']), { signal: abort.signal })).toBe(true);
    const call = doc.client.calls.find((c) => c.kind === 'documents.uploadMedia');
    expect(call.args[3].signal).toBe(abort.signal);
  });

  it('cancelled while it goes up: not refused, no list written, and the document read again', async () => {
    const doc = makeIgtDoc({ raw: buildRawDoc() });
    const errors = [];
    doc.onError = (msg, err, label) => errors.push(label);
    const abort = new AbortController();
    const order = [];
    doc.client.documents.uploadMedia = async () => {
      order.push('upload');
      abort.abort();
      throw abort.signal.reason;
    };
    const get = doc.client.documents.get;
    doc.client.documents.get = (...args) => {
      order.push('read');
      return get(...args);
    };
    const ok = await doc.uploadMedia(new Blob(['x']), {
      channelSpeakers: ['Ana', 'Ben'],
      signal: abort.signal,
    });
    expect(ok).toBe(false);
    expect(errors).toEqual([]);
    expect(doc.error).toBeFalsy();
    expect(kinds(doc)).not.toContain('documents.patchMetadata');
    expect(order).toEqual(['upload', 'read']);
    expect(doc.isSaving).toBe(false);
  });

  it('cancelled before its turn: never sent', async () => {
    const doc = makeIgtDoc({ raw: buildRawDoc() });
    const abort = new AbortController();
    abort.abort();
    const ok = await doc.uploadMedia(new Blob(['x']), { signal: abort.signal });
    expect(ok).toBe(false);
    expect(kinds(doc)).not.toContain('documents.uploadMedia');
    expect(doc.error).toBeFalsy();
  });
});
