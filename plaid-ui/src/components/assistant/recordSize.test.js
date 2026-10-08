import { describe, it, expect, vi } from 'vitest';

// The meter's storage share needs the record's size. It is measured where the
// page writes the record (the value it puts) and where it reads it, and kept
// beside the versions on `rev`, so nothing measures while drawing.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { persistConv, readConv } = await import('./jobs.js');
const { recordBytes } = await import('./usage.js');

const value = {
  messages: [{ role: 'user', content: 'kai₁ glosses' }],
  display: [{ kind: 'user', text: 'kai₁ glosses' }],
};

const storeOf = (userData) => ({
  client: { userData },
  userId: 'a@b.com',
  app: 'igt',
  projectId: 'p1',
});

describe('the record size', () => {
  it('is the written value, set on rev with the version', async () => {
    const put = vi.fn(async (_u, key) => ({ version: key.includes(':conv:') ? 4 : 2 }));
    const conv = { id: 'c1', ...value, rev: { conv: 3, meta: 1 } };
    const out = await persistConv(storeOf({ put }), conv, { id: 'c1' });
    expect(out.conv.rev).toEqual({ conv: 4, meta: 2, bytes: recordBytes(value) });
    expect(out.conv.rev.bytes).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
  });

  it('is the read value, set on rev with the version', async () => {
    const get = vi.fn(async (_u, key) =>
      key.includes(':conv:') ? { value, version: 7 } : { value: { id: 'c1' }, version: 2 },
    );
    const { conv } = await readConv(storeOf({ get }), 'c1');
    expect(conv.rev).toEqual({ conv: 7, meta: 2, bytes: recordBytes(value) });
  });
});
