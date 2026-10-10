import { describe, it, expect, vi, beforeEach } from 'vitest';

// Research telemetry's `plan.opened` from the chat: expanding a long plan
// card records the plan and the conversation it is in, through the client's
// recorder (which sends nothing while the project's switch is off). The card's
// own half is in PlanCard.test.jsx.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { all } = await import('../../test/renderComponent.jsx');
const chat = await import('../../test/assistantChat.jsx');
const { chatClient, flush, mountChat } = chat;
const { jobs, serviceCache } = await import('./jobs.js');

const SERVICE = {
  ...chat.SERVICE,
  extras: { tasks: ['assist'], app: 'igt', model: 'sonnet', maxProjects: 5 },
};

const PLAN = {
  id: 'plan-7',
  summary: '20 changes',
  labels: Array.from({ length: 20 }, (_, i) => `change ${i}`),
  ops: Array.from({ length: 20 }, () => ({ kind: 'x' })),
  changes: Array.from({ length: 20 }, (_, i) => ({ label: `change ${i}` })),
};

const CONV = {
  messages: [
    { role: 'user', content: 'gloss these' },
    { role: 'assistant', content: 'Planned.' },
  ],
  display: [
    { kind: 'user', text: 'gloss these' },
    { kind: 'assistant', text: 'Planned.', plan: PLAN, status: null },
  ],
};

// `where`: what discovery answers for each project.
const fakeClient = ({ service = SERVICE, conv = CONV, where = {} } = {}) => {
  const client = chatClient({ service, conv, where });
  client.messages.requestService = vi.fn().mockResolvedValue({});
  client.events = { record: vi.fn(() => true) };
  return client;
};

const mount = (client, conversationId = 'c1') => mountChat(client, { conversationId });

const showAll = (m) =>
  all(m.container, 'button').find((b) => b.textContent.trim().startsWith('Show all'));

beforeEach(() => {
  vi.clearAllMocks();
  jobs.clear();
  serviceCache.clear();
});

describe('AssistantChat and plan.opened', () => {
  it('records the plan and its conversation when a plan card is expanded', async () => {
    const client = fakeClient();
    const m = await mount(client);
    await flush(m);
    expect(client.events.record).not.toHaveBeenCalled();
    await m.step(() => showAll(m).click());
    expect(client.events.record).toHaveBeenCalledTimes(1);
    expect(client.events.record).toHaveBeenCalledWith('plan.opened', {
      projectId: 'p1',
      targetId: 'plan-7',
      data: { conversation: 'c1' },
    });
    await m.unmount();
  });

  it('is quiet with a client that has no recorder', async () => {
    const client = fakeClient();
    delete client.events;
    const m = await mount(client);
    await flush(m);
    await m.step(() => showAll(m).click());
    expect(showAll(m)).toBeUndefined();
    await m.unmount();
  });
});
