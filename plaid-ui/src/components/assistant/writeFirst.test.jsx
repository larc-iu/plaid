import { describe, it, expect, vi, afterEach } from 'vitest';
import PlaidClient from '@larc-iu/plaid-client';

// A plan the service may not write with its delegated token (igt's tagset
// settings) is written by the app with the user's session first, and the
// approval goes only once that write stands.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { startApply, WROTE_FIRST } = await import('./jobs.js');
const { notifyError } = await import('../../lib/notify.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const setup = () => {
  const client = new PlaidClient('http://plaid.test', 'token');
  const records = new Map();
  client.userData = {
    put: vi.fn(async (_u, key, value) => records.set(key, value)),
    get: vi.fn(async (_u, key) => (records.has(key) ? { value: records.get(key) } : null)),
  };
  const sent = [];
  globalThis.fetch = vi.fn(async (url, opts) => {
    if (String(url).includes('/services/')) sent.push(JSON.parse(opts.body));
    return { ok: false, status: 500, statusText: 'nope', text: async () => 'nope' };
  });
  return { client, sent };
};

const plan = {
  id: 'plan1',
  summary: 'Tagset',
  changes: [{ label: 'a' }],
  ops: [{ kind: 'set_tagset' }],
};

const approve = (client, writeFirst) =>
  startApply({
    store: { client, userId: 'u1', app: 'igt', projectId: 'p1' },
    service: { serviceId: 'igt:assist' },
    conv: { id: 'c1', messages: [], display: [{ kind: 'assistant', plan, status: null }] },
    plan,
    asHuman: false,
    writeFirst,
  });

describe('an approval the app writes first', () => {
  it('is sent after the app’s write', async () => {
    const { client, sent } = setup();
    const order = [];
    const j = approve(client, async () => {
      order.push(`wrote with ${sent.length} sent`);
    });
    await j.promise;
    expect(order).toEqual(['wrote with 0 sent']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ op: 'approve', 'plan-id': 'plan1' });
  });

  it('is not sent when the app’s write fails, and the job carries why', async () => {
    const { client, sent } = setup();
    const j = approve(client, async () => {
      throw new Error('1 value in Gloss is not in the tagset: dog. Nothing was written.');
    });
    await j.promise;
    expect(sent).toHaveLength(0);
    expect(j.error?.message).toMatch(/not in the tagset/);
  });

  it('says the settings stand when the approval that records them fails', async () => {
    const { client, sent } = setup();
    notifyError.mockClear();
    const j = approve(client, async () => true);
    await j.promise;
    expect(sent).toHaveLength(1);
    expect(notifyError).toHaveBeenCalledWith(WROTE_FIRST, 'Not recorded', { duration: Infinity });
    expect(notifyError.mock.calls.some(([m]) => /Nothing was written/.test(String(m)))).toBe(false);
  });
});
