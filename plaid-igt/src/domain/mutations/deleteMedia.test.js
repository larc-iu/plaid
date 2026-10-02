import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from '../IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '../test-helpers.js';

// Deleting a recording drops the speech-detection cuts measured on it, in the
// same operation, so a replacement of the same length does not bring them back.

const makeDoc = (raw) =>
  new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client: makeFakeClient(),
    projectId: 'proj-1',
  });

beforeEach(() => resetIds());

describe('deleteMedia', () => {
  it('drops the kept speech-detection cuts with the recording', async () => {
    const raw = buildRawDoc({
      metadata: {
        speechDetection: { media: '4:abc', method: 'builtin', regions: [1, 2], dismissed: [] },
        source: 'tape 4',
      },
    });
    raw.mediaUrl = '/api/v1/documents/doc-1/media?v=1-4';
    const doc = makeDoc(raw);
    expect(await doc.deleteMedia()).toBe(true);
    const calls = doc.client.calls.filter((c) => c.kind.startsWith('documents.'));
    expect(calls.map((c) => c.kind)).toEqual(['documents.deleteMedia', 'documents.patchMetadata']);
    expect(calls[1].args[1]).toEqual([{ op: 'delete', path: ['speechDetection'] }]);
    expect(doc.document.mediaUrl).toBeNull();
    expect(doc.storedMetadata.speechDetection).toBeUndefined();
    expect(doc.storedMetadata.source).toBe('tape 4');
  });

  it('writes no metadata when there were no cuts', async () => {
    const raw = buildRawDoc();
    raw.mediaUrl = '/api/v1/documents/doc-1/media?v=1-4';
    const doc = makeDoc(raw);
    expect(await doc.deleteMedia()).toBe(true);
    expect(doc.client.calls.map((c) => c.kind)).not.toContain('documents.patchMetadata');
  });
});
