import { describe, it, expect, vi, beforeEach } from 'vitest';

// A request whose service went away leaves its marker in the record, and the
// service settles it on the next op on the conversation (a turn's marker
// cleared, an approval's plan settled partly applied). A rejoin that ends with
// the record still naming its request asks for that at once, with a hold, so
// the card says Partly applied without the reader having to act first (SW-1,
// live).

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { attachJob, jobs, serviceCache } = await import('./jobs.js');
const { fakeAssistantService } = await import('../../test/fakeAssistantService.js');

const KEYS = { meta: 'igt:assistant:p1:meta:c1', conv: 'igt:assistant:p1:conv:c1' };
const plan = { id: 'plan-1', summary: '1 change', labels: ['x'] };

const setup = ({ fails = { status: 404 } } = {}) => {
  const records = new Map([
    [
      KEYS.meta,
      {
        id: 'c1',
        pending: {
          kind: 'apply',
          requestId: 'r-dead',
          serviceId: 'igt:assist:one',
          planId: 'plan-1',
        },
      },
    ],
    [KEYS.conv, { messages: [], display: [{ kind: 'assistant', text: 'P', plan, status: null }] }],
  ]);
  const assistant = fakeAssistantService(records);
  const requestService = vi.fn(async (pid, sid, data, ...rest) => {
    if (data.op === 'hold') {
      // The service settles what the dead request left, then holds.
      const meta = records.get(KEYS.meta);
      const conv = records.get(KEYS.conv);
      records.set(KEYS.conv, {
        ...conv,
        display: conv.display.map((d) =>
          d.plan?.id === 'plan-1' ? { ...d, status: 'partial', written: [] } : d,
        ),
      });
      records.set(KEYS.meta, { ...meta, pending: null });
    }
    return assistant.requestService(pid, sid, data, ...rest);
  });
  const client = {
    messages: {
      requestService,
      attachServiceRequest: vi.fn(async () => {
        throw Object.assign(new Error('gone'), fails);
      }),
    },
    userData: {
      get: vi.fn(async (_u, key) => ({ value: structuredClone(records.get(key)) })),
    },
  };
  return { records, client, store: { client, userId: 'u1', app: 'igt', projectId: 'p1' } };
};

beforeEach(() => {
  jobs.clear();
  serviceCache.clear();
});

describe('a rejoin of a request whose service went away', () => {
  it('asks the service to settle it, and shows the plan as it then stands', async () => {
    const t = setup();
    const read = {
      conv: { id: 'c1', ...t.records.get(KEYS.conv) },
      meta: t.records.get(KEYS.meta),
    };
    const j = attachJob({ store: t.store, conv: read.conv, meta: read.meta, tab: 'tab-1' });
    const result = await j.promise;
    const asked = t.client.messages.requestService.mock.calls.map((c) => c[2]);
    expect(asked).toEqual([
      expect.objectContaining({ op: 'hold', conversationId: 'c1', tab: 'tab-1' }),
    ]);
    expect(result.conv.display[0].status).toBe('partial');
    expect(result.meta.pending).toBe(null);
  });

  it('asks an assistant that is online when the one that ran it is not', async () => {
    const t = setup();
    const assistant = (serviceId) => ({
      serviceId,
      tasks: ['assist'],
      online: true,
      extras: { app: 'igt', record: 3, tasks: ['assist'] },
    });
    serviceCache.set('p1', [assistant('igt:assist:two')]);
    const read = {
      conv: { id: 'c1', ...t.records.get(KEYS.conv) },
      meta: t.records.get(KEYS.meta),
    };
    const j = attachJob({ store: t.store, conv: read.conv, meta: read.meta, tab: 'tab-1' });
    const result = await j.promise;
    const asked = t.client.messages.requestService.mock.calls.map((c) => [c[1], c[2].op]);
    expect(asked).toEqual([['igt:assist:two', 'hold']]);
    expect(result.meta.pending).toBe(null);
  });

  it('asks nothing of a request it only lost contact with, which is still running', async () => {
    const t = setup({ fails: { pending: true } });
    const read = {
      conv: { id: 'c1', ...t.records.get(KEYS.conv) },
      meta: t.records.get(KEYS.meta),
    };
    const j = attachJob({ store: t.store, conv: read.conv, meta: read.meta, tab: 'tab-1' });
    await j.promise;
    expect(t.client.messages.requestService).not.toHaveBeenCalled();
  });
});

// FX20-APPROVE: a reload rejoins the request the record still names. When the
// record already says how the plan ended, its card says so and no "Not
// applied" toast comes back.
describe('a rejoin that fails on a plan the record has settled', () => {
  const fails = { status: 503, message: 'Service disconnected' };
  const rejoin = async (item) => {
    const t = setup({ fails });
    const conv = {
      id: 'c1',
      messages: [],
      display: [{ kind: 'assistant', text: 'P', plan, ...item }],
    };
    const j = attachJob({ store: t.store, conv, meta: t.records.get(KEYS.meta), tab: 'tab-1' });
    await j.promise;
  };

  it('raises no error toast for a plan already partly applied', async () => {
    const { notifyError } = await import('../../lib/notify.js');
    notifyError.mockClear();
    await rejoin({ status: 'partial', written: [] });
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('still says it for a plan the record leaves undecided', async () => {
    const { notifyError } = await import('../../lib/notify.js');
    notifyError.mockClear();
    await rejoin({ status: null });
    expect(notifyError).toHaveBeenCalledWith(expect.anything(), 'Not applied', expect.anything());
  });
});
