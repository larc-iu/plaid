import { describe, it, expect, vi, beforeEach } from 'vitest';

// The other projects a conversation reads, through the chat itself: the set
// rides on each user message, a conversation that is opened picks it up from
// its last one, a retry carries its own, and a project joins only where the
// same assistant is online. The pure half is projectReach.test.js.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { notifyError } = await import('../../lib/notify.js');
const { MemoryRouter } = await import('react-router-dom');
const { renderComponent, all, byText } = await import('../../test/renderComponent.jsx');
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
const OLD_SERVICE = { ...SERVICE, extras: { tasks: ['assist'], app: 'igt', model: 'sonnet' } };

const B = { id: 'pB', name: 'Lamkang B' };
const C = { id: 'pC', name: 'Lamkang C' };

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

const CONV = {
  messages: [
    { role: 'user', content: 'compare -ka' },
    { role: 'assistant', content: 'Done.' },
  ],
  display: [
    { kind: 'user', text: 'compare -ka', projects: [B] },
    { kind: 'assistant', text: 'Done.' },
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
      list: vi.fn().mockResolvedValue([{ id: 'p1', name: 'Lamkang A' }, B, C]),
      ...documentsBundle(),
    },
  };
};

const mount = (client, conversationId = 'c1') =>
  renderComponent(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <AssistantChat
        projectId="p1"
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

const typeAndSend = (m, value) =>
  m.step(() => {
    const box = m.container.querySelector('textarea');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(
      box,
      value,
    );
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });

const lastAsked = (client) =>
  client.records.get('igt:assistant:p1:conv:c1').display.findLast((d) => d.kind === 'user');

const chip = (m, name) => m.container.querySelector(`[aria-label="Remove ${name}"]`);

const pick = async (m, name) => {
  await m.step(() => m.container.querySelector('[aria-label="Add project"]').click());
  await flush(m);
  const option = all(document.body, '[role="option"]').find((n) => n.textContent === name);
  await m.step(() => option.click());
  await flush(m);
};

beforeEach(() => {
  vi.clearAllMocks();
  jobs.clear();
  serviceCache.clear();
});

describe('AssistantChat and other projects', () => {
  it('brings back the projects of the conversation’s last message', async () => {
    const m = await mount(fakeClient());
    await flush(m);
    expect(chip(m, 'Lamkang B')).not.toBeNull();
    await m.unmount();
  });

  it('starts a new conversation with none', async () => {
    const m = await mount(fakeClient(), null);
    await flush(m);
    expect(chip(m, 'Lamkang B')).toBeNull();
    expect(m.container.querySelector('[aria-label="Add project"]')).not.toBeNull();
    await m.unmount();
  });

  it('writes the projects on the message it sends, and keeps them for the next', async () => {
    const client = fakeClient();
    const m = await mount(client);
    await flush(m);
    await typeAndSend(m, 'and -ki?');
    await flush(m, 8);
    expect(lastAsked(client)).toMatchObject({ text: 'and -ki?', projects: [B] });
    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    expect(chip(m, 'Lamkang B')).not.toBeNull();
    await m.unmount();
  });

  it('writes none once the last one is removed', async () => {
    const client = fakeClient();
    const m = await mount(client);
    await flush(m);
    await m.step(() => chip(m, 'Lamkang B').click());
    await typeAndSend(m, 'just here now');
    await flush(m, 8);
    expect(lastAsked(client).text).toBe('just here now');
    expect(lastAsked(client)).not.toHaveProperty('projects');
    await m.unmount();
  });

  it('adds a project where the same assistant is online', async () => {
    const client = fakeClient({ where: { pC: [SERVICE] } });
    const m = await mount(client);
    await flush(m);
    await pick(m, 'Lamkang C');
    expect(client.messages.discoverServices).toHaveBeenCalledWith('pC');
    expect(chip(m, 'Lamkang C')).not.toBeNull();
    await typeAndSend(m, 'all three?');
    await flush(m, 8);
    expect(lastAsked(client).projects).toEqual([B, C]);
    await m.unmount();
  });

  it('refuses a project where that assistant is offline, and says so', async () => {
    const client = fakeClient({ where: { pC: [{ ...SERVICE, online: false }] } });
    const m = await mount(client);
    await flush(m);
    await pick(m, 'Lamkang C');
    expect(notifyError).toHaveBeenCalledWith('The assistant is not available in Lamkang C.');
    expect(chip(m, 'Lamkang C')).toBeNull();
    await m.unmount();
  });

  it('refuses a project where only a different assistant runs', async () => {
    const other = { ...SERVICE, serviceId: 'igt:assist:two' };
    const client = fakeClient({ where: { pC: [other] } });
    const m = await mount(client);
    await flush(m);
    await pick(m, 'Lamkang C');
    expect(notifyError).toHaveBeenCalledWith('The assistant is not available in Lamkang C.');
    expect(chip(m, 'Lamkang C')).toBeNull();
    await m.unmount();
  });

  it('sends a failed message again with its own projects', async () => {
    const client = fakeClient({
      conv: {
        messages: [],
        display: [
          { kind: 'user', text: 'compare -ka', projects: [B] },
          { kind: 'error', text: 'The assistant could not answer: boom' },
        ],
      },
    });
    const m = await mount(client);
    await flush(m);
    // The chips are the reader's next message, and a change to them is not
    // what the failed one read.
    await m.step(() => chip(m, 'Lamkang B').click());
    await m.step(() => byText(m.container, 'button', 'Retry').click());
    await flush(m, 8);
    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    expect(lastAsked(client)).toMatchObject({ text: 'compare -ka', projects: [B] });
    await m.unmount();
  });

  it('offers nothing, and writes nothing, for an assistant that reads one project', async () => {
    const client = fakeClient({ service: OLD_SERVICE });
    const m = await mount(client);
    await flush(m);
    expect(m.container.querySelector('[aria-label="Add project"]')).toBeNull();
    expect(chip(m, 'Lamkang B')).toBeNull();
    await typeAndSend(m, 'and -ki?');
    await flush(m, 8);
    expect(lastAsked(client)).not.toHaveProperty('projects');
    await m.unmount();
  });
});
