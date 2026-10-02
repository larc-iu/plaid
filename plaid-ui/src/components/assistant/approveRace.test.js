import { describe, it, expect, vi, afterEach } from 'vitest';

// H8-ASSISTANT-3: approving one plan in two tabs at once. The tab whose run
// lost the document lock was told to approve again and kept the card
// undecided after the other tab applied the plan. It now reads its record
// again until the plan is decided there.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { startApply, jobListeners } = await import('./jobs.js');

const plan = { id: 'p1', summary: '2 field values', ops: [] };
const card = (status) => ({ kind: 'assistant', plan, status });

const setup = (records) => {
  let reads = 0;
  const client = {
    messages: {
      requestService: vi.fn(async () => {
        throw Object.assign(new Error('Nothing was written. "Xnaai" is locked by another run.'), {
          status: 500,
        });
      }),
    },
    userData: {
      put: vi.fn(async () => ({})),
      get: vi.fn(async (_user, key) => {
        if (key.includes(':meta:')) return { value: { id: 'c1' } };
        const display = records[Math.min(reads, records.length - 1)];
        reads += 1;
        return { value: { messages: [], display } };
      }),
    },
  };
  const store = { client, userId: 'u1', app: 'igt', projectId: 'proj' };
  const conv = { id: 'c1', messages: [], display: [card(null)] };
  const seen = [];
  const listen = (j) => seen.push(j);
  jobListeners.add(listen);
  return { store, conv, seen, stop: () => jobListeners.delete(listen) };
};

describe('an approval refused while the plan is applying elsewhere', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the plan as applied once the record says so', async () => {
    vi.useFakeTimers();
    const { store, conv, seen, stop } = setup([[card(null)], [card(null)], [card('applied')]]);
    const j = startApply({
      store,
      service: { serviceId: 's1' },
      conv,
      prevMeta: null,
      plan,
      asHuman: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    await j.promise;
    expect(j.result.conv.display[0].status).toBe(null);
    await vi.advanceTimersByTimeAsync(10000);
    const settled = seen.filter((x) => x.done && x.result.conv.display[0].status === 'applied');
    expect(settled).toHaveLength(1);
    expect(settled[0].error).toBe(null);
    stop();
  });
});
