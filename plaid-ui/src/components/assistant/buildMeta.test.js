import { describe, it, expect } from 'vitest';
import { buildMeta, readConv } from './jobs.js';

// The sidebar entry a write leaves behind. What is pinned here is that it knows
// which project it belongs to: the list holds rows from more than one, and a
// row that has forgotten is a row that cannot be deleted or linked to.

const store = (records = new Map()) => ({
  client: {
    userData: { get: async (_u, key) => (records.has(key) ? { value: records.get(key) } : null) },
  },
  userId: 'a@b.com',
  app: 'igt',
  projectId: 'p1',
});

const conv = { id: 'c1', messages: [], display: [{ kind: 'user', text: 'gloss it' }] };

describe('buildMeta', () => {
  it('carries the project it is written under', () => {
    expect(buildMeta(store(), null, conv, null).projectId).toBe('p1');
  });

  it('carries it for a settled entry too, so the row does not lose its project', () => {
    // What settles a turn: the record is read back and the entry is rebuilt
    // with no pending request. It goes straight into the list, replacing the
    // row that was listed there.
    const prev = { id: 'c1', projectId: 'p1', title: 'Thread', createdAt: '2026-09-01T00:00:00Z' };
    const settled = buildMeta(store(), prev, conv, null, null);
    expect(settled.projectId).toBe('p1');
    expect(settled.pending).toBeNull();
    expect(settled.title).toBe('Thread');
  });
});

describe('readConv', () => {
  it('stamps the entry with the project whose keys it was read under', async () => {
    const records = new Map([
      ['igt:assistant:p1:conv:c1', { messages: [], display: [] }],
      ['igt:assistant:p1:meta:c1', { id: 'c1', title: 'Thread' }],
    ]);
    const { meta } = await readConv(store(records), 'c1');
    expect(meta.projectId).toBe('p1');
  });

  it('reads nothing back as nothing', async () => {
    const { meta, conv: read } = await readConv(store(), 'c1');
    expect(meta).toBeNull();
    expect(read).toEqual({ id: 'c1', messages: [], display: [] });
  });
});
