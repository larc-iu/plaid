import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConlluDocument } from './ConlluDocument.js';

// What a failed mutation REPORTS. The document shows nothing itself: it hands
// the screen three things through `onError`, the composed message, the raw
// error and the label of what it was doing. The label is the toast's title and
// the error its description, and the screen (DocumentEditorShell) words it.
// Handing over one composed string once lost both halves: the toast read the
// status out of it and replaced the whole sentence, label included.

const RAW = {
  id: 'doc-1',
  name: 'Test',
  project: { id: 'proj-1' },
  textLayers: [],
};

const failingClient = (err) => ({
  withOperation: async () => {
    throw err;
  },
  documents: { get: async () => RAW },
});

const httpError = (status, message) => Object.assign(new Error(message), { status });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a mutation that fails', () => {
  it('reports the label and the raw error separately', async () => {
    const err = httpError(
      503,
      'HTTP 503 Service Unavailable at http://localhost:8085/api/v1/documents/doc-1',
    );
    const doc = new ConlluDocument({ raw: RAW, client: failingClient(err), projectId: 'proj-1' });
    doc.onError = vi.fn();

    const ok = await doc._withSaving('Failed to create relation', async () => {});

    expect(ok).toBe(false);
    expect(doc.onError).toHaveBeenCalledTimes(1);
    const [message, raw, label] = doc.onError.mock.calls[0];
    expect(label).toBe('Failed to create relation');
    expect(raw).toBe(err);
    expect(message).toBe(`Failed to create relation: ${err.message}`);
    expect(doc.error).toBe(message);
  });

  it('reports a validation refusal once, with no error object', () => {
    const doc = new ConlluDocument({ raw: RAW, projectId: 'proj-1' });
    doc.onError = vi.fn();
    doc.setError('A feature is written Key=Value.');
    doc.setError('A feature is written Key=Value.');
    expect(doc.onError).toHaveBeenCalledTimes(1);
    expect(doc.onError).toHaveBeenCalledWith('A feature is written Key=Value.');
  });

  it('says nothing when no screen has wired it', async () => {
    const doc = new ConlluDocument({
      raw: RAW,
      client: failingClient(new Error('the span layer is gone')),
      projectId: 'proj-1',
    });
    const ok = await doc._withSaving('Failed to update annotation', async () => {});
    expect(ok).toBe(false);
    expect(doc.error).toBe('Failed to update annotation: the span layer is gone');
  });

  it('carries the handler onto a snapshot', async () => {
    const doc = new ConlluDocument({
      raw: RAW,
      client: { documents: { get: async () => RAW } },
      projectId: 'proj-1',
    });
    const onError = () => {};
    doc.onError = onError;
    const snapshot = await doc.atAsOf('2026-09-01T00:00:00Z');
    expect(snapshot.onError).toBe(onError);
  });
});
