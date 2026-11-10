import { describe, it, expect, beforeEach } from 'vitest';
import { buildRawDoc, resetIds, makeIgtDoc } from '../test-helpers.js';

// The speaker on each channel of a mixed recording rides with the recording:
// written after the upload lands, so a failed upload leaves no list, and
// dropped with the recording, and by a plain upload, so a plain recording
// never carries a list from before it.

beforeEach(() => resetIds());

describe('uploadMedia with channelSpeakers', () => {
  it('writes the list after the upload, in the same send, then reloads', async () => {
    const doc = makeIgtDoc({ raw: buildRawDoc() });
    const ok = await doc.uploadMedia(new Blob(['x']), { channelSpeakers: ['Ana', ''] });
    expect(ok).toBe(true);
    const kinds = doc.client.calls.map((c) => c.kind).filter((k) => k.startsWith('documents.'));
    expect(kinds.indexOf('documents.uploadMedia')).toBeLessThan(
      kinds.indexOf('documents.patchMetadata'),
    );
    const patch = doc.client.calls.find((c) => c.kind === 'documents.patchMetadata');
    expect(patch.args).toEqual([
      'doc-1',
      [{ op: 'set', path: ['channelSpeakers'], value: ['Ana', ''] }],
    ]);
  });

  it('writes no list for a plain upload', async () => {
    const doc = makeIgtDoc({ raw: buildRawDoc() });
    await doc.uploadMedia(new Blob(['x']));
    expect(doc.client.calls.map((c) => c.kind)).not.toContain('documents.patchMetadata');
  });

  // The cuts name the recording they were measured on by its print, so the
  // screen shows none of them for another recording, and the same recording
  // uploaded again (onto an archive imported without its media) has them.
  it('a plain upload drops a stored list and keeps the detected cuts, after the upload', async () => {
    const doc = makeIgtDoc({
      raw: buildRawDoc({
        metadata: {
          speechDetection: { media: '4:abc', method: 'builtin', regions: [1, 2], dismissed: [] },
          channelSpeakers: ['Ana', 'Ben'],
          source: 'tape 4',
        },
      }),
    });
    expect(await doc.uploadMedia(new Blob(['x']))).toBe(true);
    const kinds = doc.client.calls.map((c) => c.kind).filter((k) => k.startsWith('documents.'));
    expect(kinds.indexOf('documents.uploadMedia')).toBeLessThan(
      kinds.indexOf('documents.patchMetadata'),
    );
    const patch = doc.client.calls.find((c) => c.kind === 'documents.patchMetadata');
    expect(patch.args[1]).toEqual([{ op: 'delete', path: ['channelSpeakers'] }]);
  });

  it('a plain upload onto kept cuts and no list writes no metadata', async () => {
    const doc = makeIgtDoc({
      raw: buildRawDoc({
        metadata: {
          speechDetection: { media: '4:abc', method: 'builtin', regions: [1, 2], dismissed: ['a'] },
        },
      }),
    });
    expect(await doc.uploadMedia(new Blob(['x']))).toBe(true);
    expect(doc.client.calls.map((c) => c.kind)).not.toContain('documents.patchMetadata');
  });

  it('a mix replaces a stored list and keeps the detected cuts', async () => {
    const doc = makeIgtDoc({
      raw: buildRawDoc({
        metadata: {
          speechDetection: { media: '4:abc', method: 'builtin', regions: [1, 2], dismissed: [] },
          channelSpeakers: ['Ana', 'Ben'],
        },
      }),
    });
    await doc.uploadMedia(new Blob(['x']), { channelSpeakers: ['Cy', 'Di'] });
    const patch = doc.client.calls.find((c) => c.kind === 'documents.patchMetadata');
    expect(patch.args[1]).toEqual([{ op: 'set', path: ['channelSpeakers'], value: ['Cy', 'Di'] }]);
  });

  // The recording is there: the toast says what was not saved, not that the
  // upload failed.
  it('a refused list after the upload landed is said as the list not saved', async () => {
    const doc = makeIgtDoc({ raw: buildRawDoc() });
    const errors = [];
    doc.onError = (msg, err, label) => errors.push({ msg, err, label });
    doc.client.documents.patchMetadata = async () => {
      throw Object.assign(new Error('The server hit an unexpected error.'), { status: 500 });
    };
    await doc.uploadMedia(new Blob(['x']), { channelSpeakers: ['Ana', 'Ben'] });
    expect(errors.map((e) => e.label)).toEqual(['Speakers per channel not saved']);
    expect(errors[0].err.status).toBe(500);
  });

  it('writes no list when the upload fails', async () => {
    const doc = makeIgtDoc({ raw: buildRawDoc() });
    doc.client.documents.uploadMedia = async () => {
      throw Object.assign(new Error('HTTP 415'), { status: 415 });
    };
    expect(await doc.uploadMedia(new Blob(['x']), { channelSpeakers: ['Ana', 'Ben'] })).toBe(false);
    expect(doc.client.calls.map((c) => c.kind)).not.toContain('documents.patchMetadata');
  });
});

describe('deleteMedia with channelSpeakers', () => {
  it('drops the channel speakers with the recording, beside the detected cuts', async () => {
    const raw = buildRawDoc({
      metadata: {
        speechDetection: { media: '4:abc', method: 'builtin', regions: [1, 2], dismissed: [] },
        channelSpeakers: ['Ana', 'Ben'],
        source: 'tape 4',
      },
    });
    raw.mediaUrl = '/api/v1/documents/doc-1/media?v=1-4';
    const doc = makeIgtDoc({ raw });
    expect(await doc.deleteMedia()).toBe(true);
    const patch = doc.client.calls.find((c) => c.kind === 'documents.patchMetadata');
    expect(patch.args[1]).toEqual([
      { op: 'delete', path: ['speechDetection'] },
      { op: 'delete', path: ['channelSpeakers'] },
    ]);
    expect(doc.storedMetadata.channelSpeakers).toBeUndefined();
    expect(doc.storedMetadata.source).toBe('tape 4');
  });

  it('drops the channel speakers alone when there were no cuts', async () => {
    const raw = buildRawDoc({ metadata: { channelSpeakers: ['Ana', 'Ben'] } });
    raw.mediaUrl = '/api/v1/documents/doc-1/media?v=1-4';
    const doc = makeIgtDoc({ raw });
    expect(await doc.deleteMedia()).toBe(true);
    const patch = doc.client.calls.find((c) => c.kind === 'documents.patchMetadata');
    expect(patch.args[1]).toEqual([{ op: 'delete', path: ['channelSpeakers'] }]);
  });
});

describe('knownSpeakers with channelSpeakers', () => {
  it("counts the speaker on each channel among the document's speakers", () => {
    const doc = makeIgtDoc({
      raw: buildRawDoc({ metadata: { channelSpeakers: ['Zed', '', 'Ana'] } }),
    });
    expect(doc.knownSpeakers).toEqual(['Ana', 'Zed']);
  });
});
