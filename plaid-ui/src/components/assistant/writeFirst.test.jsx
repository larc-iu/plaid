import { describe, it, expect, vi } from 'vitest';
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

const { startApply, WROTE_FIRST, WROTE_GONE } = await import('./jobs.js');
const { notifyError, notifyWarning } = await import('../../lib/notify.js');

// The service, as the page meets it: the preflight answers `preflight`, the
// approval `approval` (an Error rejects).
const setup = ({ preflight = { kind: 'ready' }, approval = new Error('nope') } = {}) => {
  const client = new PlaidClient('http://plaid.test', 'token');
  const records = new Map();
  client.userData = {
    put: vi.fn(async (_u, key, value) => records.set(key, value)),
    get: vi.fn(async (_u, key) => (records.has(key) ? { value: records.get(key) } : null)),
  };
  const sent = [];
  client.messages.requestService = vi.fn(async (_p, _s, data) => {
    sent.push(data);
    const answer = data.preflight ? preflight : approval;
    if (answer instanceof Error) throw answer;
    return answer;
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
  it('asks a preflight, writes, then sends the approval saying it wrote', async () => {
    const { client, sent } = setup({ approval: { kind: 'applied', applied: 1, counts: [] } });
    const order = [];
    const j = approve(client, async () => {
      order.push(`wrote with ${sent.length} sent`);
      return true;
    });
    await j.promise;
    expect(order).toEqual(['wrote with 1 sent']);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ op: 'approve', planId: 'plan1', preflight: true });
    expect(sent[1]).toMatchObject({ op: 'approve', planId: 'plan1', wroteFirst: true });
    expect(sent[1].preflight).toBeUndefined();
  });

  it('says nothing of a write when the page wrote nothing (the settings already read as planned)', async () => {
    const { client, sent } = setup({ approval: { kind: 'applied', applied: 1, counts: [] } });
    await approve(client, async () => false).promise;
    expect(sent).toHaveLength(2);
    expect(sent[1].wroteFirst).toBeUndefined();
  });

  it.each([
    ['refused', { kind: 'refused', why: 'held', message: 'Open in another tab.' }],
    ['gone', { kind: 'refused', why: 'gone' }],
  ])('writes nothing and sends no approval when the preflight is %s', async (_n, answer) => {
    const { client, sent } = setup({ preflight: answer });
    const wrote = vi.fn(async () => true);
    const j = approve(client, wrote);
    await j.promise;
    expect(wrote).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(j.outcome).toEqual(answer);
    expect(j.wroteFirst).toBeFalsy();
  });

  it('writes nothing when the preflight is turned down (a discarded plan), and the job carries why', async () => {
    const { client, sent } = setup({ preflight: new Error('The plan was discarded') });
    const wrote = vi.fn(async () => true);
    const j = approve(client, wrote);
    await j.promise;
    expect(wrote).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(j.error?.message).toMatch(/discarded/);
  });

  it('is not sent when the app’s write fails: the mark comes off, and the job carries why', async () => {
    const { client, sent } = setup();
    const j = approve(client, async () => {
      throw new Error('1 value in Gloss is not in the tagset: dog. Nothing was written.');
    });
    await j.promise;
    expect(sent).toHaveLength(2);
    expect(sent[0].preflight).toBe(true);
    expect(sent[1]).toMatchObject({ op: 'unmark', planId: 'plan1' });
    expect(j.error?.message).toMatch(/not in the tagset/);
  });

  it('tells the preflight the box, for a discard that records a lost approval', async () => {
    const { client, sent } = setup({ approval: { kind: 'applied', applied: 1, counts: [] } });
    await startApply({
      store: { client, userId: 'u1', app: 'igt', projectId: 'p1' },
      service: { serviceId: 'igt:assist' },
      conv: { id: 'c1', messages: [], display: [{ kind: 'assistant', plan, status: null }] },
      plan,
      asHuman: true,
      writeFirst: async () => true,
    }).promise;
    expect(sent[0]).toMatchObject({ preflight: true, asHuman: true });
  });

  it('says the settings stand when the approval that records them fails', async () => {
    const { client, sent } = setup();
    notifyError.mockClear();
    const j = approve(client, async () => true);
    await j.promise;
    expect(sent).toHaveLength(2);
    expect(notifyError).toHaveBeenCalledWith(WROTE_FIRST, 'Not recorded', { duration: Infinity });
    expect(notifyError.mock.calls.some(([m]) => /Nothing was written/.test(String(m)))).toBe(false);
  });

  it('says the settings stand when the conversation was deleted after the write', async () => {
    const { client } = setup({ approval: { kind: 'refused', why: 'gone' } });
    notifyWarning.mockClear();
    await approve(client, async () => true).promise;
    expect(notifyWarning).toHaveBeenCalledWith(WROTE_GONE, 'Not recorded');
  });
});

describe('the operation the app’s write of a plan is in', () => {
  it('is the one the service opens for a plan: label, kind and ref', async () => {
    const { planOperation } = await import('./jobs.js');
    expect(
      planOperation('c1', { id: 'p9', summary: 'Tagset ⁨Leipzig⁩ closed' }, 'igt:assist:m'),
    ).toEqual({
      message: 'Assistant: Tagset Leipzig closed',
      kind: 'assistant-plan',
      ref: 'conv:c1/plan:p9/service:igt:assist:m',
    });
    const long = planOperation('c1', { id: 'p9', summary: 'x'.repeat(500) }, 's');
    expect(Array.from(long.message)).toHaveLength(400);
    expect(long.message.endsWith('…')).toBe(true);
  });
});
