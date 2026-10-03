import { describe, it, expect, beforeEach } from 'vitest';
import { IgtDocument } from '../IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '../test-helpers.js';

// A delete names the recording on screen (H36-SETTINGS-LIVE-1). One replaced
// by someone else since is refused, nothing else is written, the refusal says
// so, and the page then shows the current recording.

const OLD = '/api/v1/documents/doc-1/media?v=1000-5';
const NEW = '/api/v1/documents/doc-1/media?v=2000-7';

beforeEach(() => resetIds());

const makeDoc = (raw, client) =>
  new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client,
    projectId: 'proj-1',
  });

describe('deleteMedia names the recording', () => {
  it('sends the version of the recording on screen', async () => {
    const raw = buildRawDoc();
    raw.mediaUrl = OLD;
    const doc = makeDoc(raw, makeFakeClient());
    expect(await doc.deleteMedia()).toBe(true);
    const call = doc.client.calls.find((c) => c.kind === 'documents.deleteMedia');
    expect(call.args[2]).toEqual({ mediaVersion: '1000-5' });
  });

  it('is refused when the recording was replaced, and shows the current one', async () => {
    const raw = buildRawDoc({
      metadata: { speechDetection: { media: '4:abc', method: 'builtin', regions: [1, 2] } },
    });
    raw.mediaUrl = OLD;
    const current = buildRawDoc({
      metadata: { speechDetection: { media: '4:abc', method: 'builtin', regions: [1, 2] } },
    });
    current.mediaUrl = NEW;
    const client = makeFakeClient({ reloadDoc: current });
    client.documents.deleteMedia = async () => {
      throw Object.assign(new Error('HTTP 409 The recording changed'), {
        status: 409,
        method: 'DELETE',
        responseData: { error: 'The recording changed', 'media-changed': true, 'media-url': NEW },
      });
    };
    const doc = makeDoc(raw, client);
    const errors = [];
    doc.onError = (msg, err, label) => errors.push({ msg, err, label });
    expect(await doc.deleteMedia()).toBe(false);
    expect(client.calls.map((c) => c.kind)).not.toContain('documents.patchMetadata');
    expect(doc.document.mediaUrl).toBe(NEW);
    expect(errors).toHaveLength(1);
    expect(errors[0].label).toBe('Failed to delete media');
    expect(errors[0].err.message).toBe('Replaced elsewhere. Showing the current recording.');
  });
});
