import { describe, it, expect, vi, afterEach } from 'vitest';
import PlaidClient from '@larc-iu/plaid-client';

import { renderComponent } from '../../test/renderComponent.jsx';

// A client has one open operation at a time, and every editor write opens
// one while it saves (DocumentModel._queueWrite). A request made in that
// window used to carry the edit's operation to the service, which joined it:
// the whole approved plan, or the whole service run, was recorded in the
// audit log as that edit, under the edit's kind. Approving a plan, a turn
// and a service run are each their own action, so their requests carry none
// and the service starts its own group.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { startApply, startTurn } = await import('./jobs.js');
const { useServiceRequest } = await import('../../hooks/useServiceRequest.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A real client with an editor write still saving, whose service requests
// are refused after their body has been seen.
const savingClient = () => {
  const client = new PlaidClient('http://plaid.test', 'token');
  const records = new Map();
  client.userData = {
    put: vi.fn(async (_u, key, value) => {
      records.set(key, value);
    }),
    get: vi.fn(async (_u, key) => (records.has(key) ? { value: records.get(key) } : null)),
  };
  const sent = [];
  globalThis.fetch = vi.fn(async (url, opts) => {
    if (String(url).includes('/services/')) sent.push(JSON.parse(opts.body));
    return { ok: false, status: 500, statusText: 'nope', text: async () => 'nope' };
  });
  client.beginOperation('Gloss s1.w2', { kind: 'guess-adoption' });
  return { client, sent };
};

const storeOf = (client) => ({ client, userId: 'u1', app: 'igt', projectId: 'p1' });

const plan = {
  id: 'plan1',
  summary: '1 gloss',
  labels: ['a'],
  changes: [{ label: 'a' }],
  ops: [{ kind: 'x' }],
};

describe('a request that is its own action, made while an edit is saving', () => {
  it('approving a plan carries no operation', async () => {
    const { client, sent } = savingClient();
    const conv = { id: 'c1', messages: [], display: [{ kind: 'assistant', plan, status: null }] };
    const j = startApply({
      store: storeOf(client),
      service: { serviceId: 'igt:assist' },
      conv,
      plan,
      asHuman: false,
    });
    await j.promise;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ op: 'approve', 'plan-id': 'plan1' });
    expect(sent[0]).not.toHaveProperty('operation-group');
    expect(client.operationGroup?.kind).toBe('guess-adoption');
  });

  it('a turn carries no operation', async () => {
    const { client, sent } = savingClient();
    const conv = { id: 'c2', messages: [], display: [{ kind: 'user', text: 'gloss it' }] };
    const j = startTurn({
      store: storeOf(client),
      service: { serviceId: 'igt:assist' },
      conv,
      text: 'gloss it',
    });
    await j.promise;
    expect(sent).toHaveLength(1);
    expect(sent[0]['conversation-id']).toBe('c2');
    expect(sent[0]).not.toHaveProperty('operation-group');
  });

  it('a service run carries no operation, and one the caller opened for it is carried', async () => {
    const { client, sent } = savingClient();
    const seen = { current: null };
    const Probe = () => {
      seen.current = useServiceRequest(client);
      return null;
    };
    const r = await renderComponent(<Probe />);
    await r.step(async () => {
      await seen.current.requestService('p1', 'd1', 'svc', { documentId: 'd1' }).catch(() => {});
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('operation-group');
    await r.step(async () => {
      await seen.current
        .requestService('p1', 'd1', 'svc', { documentId: 'd1' }, { inOperation: true })
        .catch(() => {});
    });
    expect(sent[1]['operation-group'].kind).toBe('guess-adoption');
  });
});
