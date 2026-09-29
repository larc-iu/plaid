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

const { MemoryRouter } = await import('react-router-dom');
const { renderComponent, all } = await import('../../test/renderComponent.jsx');
const { documentsBundle } = await import('../../test/fakeClient.js');
const { AssistantChat } = await import('./AssistantChat.jsx');
const { jobs, serviceCache } = await import('./jobs.js');

const ADAPTER = {
  app: 'igt',
  command: 'plaid-igt-agent',
  intro: 'Ask about this project.',
  examples: [],
  textName: 'the transcription',
  convHref: (projectId, id) => `/projects/${projectId}?tab=assistant&conversation=${id}`,
  CITE_RE: /<cite\s[^>]*\/>/g,
  citationTitle: () => 'Sentence',
  citationHref: () => '/sentence',
  citationToMarkdown: (m) => m,
  ExampleCard: () => null,
  groupOf: () => ({ key: 'doc', title: 'Text 1', href: null }),
  changePlace: () => ({ name: 'Text 1', href: null }),
  parseCitationHref: () => null,
};

const SERVICE = {
  serviceId: 'igt:assist:one',
  serviceName: 'Assistant one',
  online: true,
  extras: { tasks: ['assist'], app: 'igt', model: 'sonnet', maxProjects: 5 },
};

const META = {
  id: 'c1',
  title: 'A thread',
  createdAt: '2026-09-11T00:00:00Z',
  updatedAt: '2026-09-12T00:00:00Z',
  serviceId: SERVICE.serviceId,
  model: 'sonnet',
  turns: 1,
  about: null,
  pending: null,
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
  const records = new Map([
    ['igt:assistant:p1:meta:c1', META],
    ['igt:assistant:p1:conv:c1', conv],
  ]);
  return {
    records,
    messages: {
      discoverServices: vi.fn(async (pid) => (pid === 'p1' ? [service] : (where[pid] ?? []))),
      requestService: vi.fn().mockResolvedValue({}),
      attachServiceRequest: vi.fn().mockResolvedValue({}),
      cancelServiceRequest: vi.fn().mockResolvedValue({}),
    },
    userData: {
      list: vi.fn(async (userId, { prefix } = {}) =>
        [...records]
          .filter(([key]) => (prefix ? key.startsWith(prefix) : key.includes(':meta:')))
          .map(([key, value]) => ({ key, value })),
      ),
      get: vi.fn(async (userId, key) => (records.has(key) ? { value: records.get(key) } : null)),
      put: vi.fn(async (userId, key, value) => {
        records.set(key, value);
      }),
      delete: vi.fn(async (userId, key) => {
        records.delete(key);
      }),
    },
    projects: {
      list: vi.fn().mockResolvedValue([{ id: 'p1', name: 'Lamkang A' }]),
      ...documentsBundle(),
    },
    events: { record: vi.fn(() => true) },
  };
};

const mount = (client, conversationId = 'c1') =>
  renderComponent(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <AssistantChat
        projectId="p1"
        projectName="Lamkang A"
        client={client}
        userId="u1"
        canWrite
        adapter={ADAPTER}
        conversationId={conversationId}
      />
    </MemoryRouter>,
  );

const flush = async (m, times = 4) => {
  for (let i = 0; i < times; i++)
    await m.step(() => new Promise((resolve) => setTimeout(resolve, 0)));
};

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
