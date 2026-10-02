import { describe, it, expect, vi } from 'vitest';
import { DocumentModel } from './DocumentModel.js';

// H11-MULTI-2 for every app: a document a screen holds reads its project again
// every minute on a visible tab, so a change of whose work is reviewed reaches
// ud's and umr's pages as it reached igt's.
describe('the project a held document keeps', () => {
  it('is read again every minute while held, and not once let go', async () => {
    vi.useFakeTimers();
    try {
      const server = { id: 'p1', config: {} };
      const client = { projects: { get: vi.fn(async () => structuredClone(server)) } };
      const doc = new DocumentModel({
        raw: { id: 'd1' },
        client,
        projectId: 'p1',
        project: { id: 'p1', config: {} },
      });
      const v0 = doc.dataVersion;
      const release = doc.hold();
      server.config = { plaid: { review: { users: ['b@x.com'] } } };
      await vi.advanceTimersByTimeAsync(60_000);
      expect(doc.project.config.plaid.review.users).toEqual(['b@x.com']);
      expect(doc.dataVersion).toBe(v0 + 1);
      release();
      const calls = client.projects.get.mock.calls.length;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(client.projects.get.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
