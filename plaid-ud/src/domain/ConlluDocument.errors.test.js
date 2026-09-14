import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// What a failed mutation SAYS. The document's error channel is a toast, and a
// toast has two halves: the title names what was being done, the description
// says what went wrong.
//
// This one composed both into a single string and handed it over as the
// description. The description is read through `humanizeError`, which finds
// the status the raw client message carries and replaces the WHOLE sentence
// with its own, so the label went with it and every failure was titled
// "Error". Asserted at the toast rather than at `notifyError`, because what
// went wrong was which argument the label was in.

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { ConlluDocument } = await import('./ConlluDocument.js');

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
  isBatchMode: () => false,
  abortBatch: () => {},
  documents: { get: async () => RAW },
});

const httpError = (status, message) => Object.assign(new Error(message), { status });

beforeEach(() => {
  toast.error.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a mutation that fails', () => {
  it('titles the toast with what it was doing and describes the status', async () => {
    const err = httpError(
      503,
      'HTTP 503 Service Unavailable at http://localhost:8085/api/v1/documents/doc-1',
    );
    const doc = new ConlluDocument({ raw: RAW, client: failingClient(err), projectId: 'proj-1' });

    const ok = await doc._withSaving('Failed to create relation', async () => {});

    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
    const [title, options] = toast.error.mock.calls[0];
    expect(title).toBe('Failed to create relation');
    expect(options.description).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  it('describes an error that carries no status without repeating the label', async () => {
    const doc = new ConlluDocument({
      raw: RAW,
      client: failingClient(new Error('the span layer is gone')),
      projectId: 'proj-1',
    });

    await doc._withSaving('Failed to update annotation', async () => {});

    const [title, options] = toast.error.mock.calls[0];
    expect(title).toBe('Failed to update annotation');
    expect(options.description).toBe('the span layer is gone');
  });
});
