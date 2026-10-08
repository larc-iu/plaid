import { describe, it, expect, vi, beforeEach } from 'vitest';

// The chat over a record other tabs write: a conversation deleted in another
// tab (H10-RECORD-5), and a message sent while another tab's approval runs
// (H10-RECORD-2). The record layer's half is recordClaims.test.js.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { MemoryRouter } = await import('react-router-dom');
const { renderComponent, all } = await import('../../test/renderComponent.jsx');
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
  opensProject: () => true,
};

const SERVICE = {
  serviceId: 'igt:assist:one',
  serviceName: 'Assistant one',
  online: true,
  extras: { tasks: ['assist'], app: 'igt', model: 'sonnet' },
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

const CONV = {
  messages: [
    { role: 'user', content: 'gloss it' },
    { role: 'assistant', content: 'Done.' },
  ],
  display: [
    { kind: 'user', text: 'gloss it' },
    { kind: 'assistant', text: 'Done.' },
  ],
};

const KEYS = { meta: 'igt:assistant:p1:meta:c1', conv: 'igt:assistant:p1:conv:c1' };

// The user's data as core keeps it: versions, 404 for what is gone, and a
// write naming a version the entry is no longer at refused with 409.
const fakeClient = () => {
  const records = new Map([
    [KEYS.meta, { value: META, version: 1 }],
    [KEYS.conv, { value: CONV, version: 1 }],
  ]);
  const gone = () => Object.assign(new Error('Not found'), { status: 404 });
  return {
    records,
    messages: {
      discoverServices: vi.fn(async () => [SERVICE]),
      requestService: vi.fn(() => new Promise(() => {})),
      attachServiceRequest: vi.fn(() => new Promise(() => {})),
      cancelServiceRequest: vi.fn().mockResolvedValue({}),
    },
    userData: {
      list: vi.fn(async () =>
        [...records]
          .filter(([key]) => key.includes(':meta:'))
          .map(([key, { value }]) => ({ key, value })),
      ),
      get: vi.fn(async (_u, key) => {
        if (!records.has(key)) throw gone();
        const { value, version } = records.get(key);
        return { key, value: structuredClone(value), version };
      }),
      put: vi.fn(async (_u, key, value, { version } = {}) => {
        const stored = records.get(key)?.version ?? 0;
        if (version !== undefined && version !== stored) {
          throw Object.assign(new Error('HTTP 409'), { status: 409 });
        }
        records.set(key, { value: structuredClone(value), version: stored + 1 });
        return { key, version: stored + 1 };
      }),
      delete: vi.fn(async (_u, key) => {
        records.delete(key);
      }),
    },
    projects: { list: vi.fn().mockResolvedValue([{ id: 'p1', name: 'Lamkang A' }]) },
    server: { limits: vi.fn().mockResolvedValue({}) },
  };
};

const mount = (client) =>
  renderComponent(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <AssistantChat
        projectId="p1"
        projectName="Lamkang A"
        client={client}
        userId="u1"
        canWrite
        adapter={ADAPTER}
        conversationId="c1"
      />
    </MemoryRouter>,
  );

const flush = async (m, times = 6) => {
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

beforeEach(() => {
  vi.clearAllMocks();
  jobs.clear();
  serviceCache.clear();
});

describe('a conversation deleted in another tab', () => {
  it('keeps the page and the typed message, and offers a new conversation', async () => {
    const client = fakeClient();
    const m = await mount(client);
    await flush(m);
    client.records.delete(KEYS.meta);
    client.records.delete(KEYS.conv);
    await typeAndSend(m, 'Still there?');
    await flush(m, 10);
    expect(m.container.querySelector('textarea')).not.toBeNull();
    expect(m.container.textContent).toContain('This conversation was deleted.');
    expect(m.container.querySelector('textarea').value).toBe('Still there?');
    const fresh = all(m.container, 'button').find(
      (b) => b.textContent.trim() === 'New conversation',
    );
    expect(fresh).toBeTruthy();
    expect(client.messages.requestService).not.toHaveBeenCalled();
    expect(client.records.has(KEYS.meta)).toBe(false);
    await m.step(() => fresh.click());
    await flush(m);
    expect(m.container.querySelector('textarea').value).toBe('Still there?');
    expect(m.container.textContent).not.toContain('This conversation was deleted.');
    await m.unmount();
  });
});

describe('a message sent while another tab applies a plan', () => {
  it('waits in the composer, which says the changes are being applied', async () => {
    const client = fakeClient();
    const m = await mount(client);
    await flush(m);
    const { value, version } = client.records.get(KEYS.meta);
    client.records.set(KEYS.meta, {
      value: {
        ...value,
        updatedAt: '2026-09-12T00:01:00Z',
        pending: {
          kind: 'apply',
          requestId: 'r-apply',
          serviceId: SERVICE.serviceId,
          planId: 'p1',
          startedAt: new Date().toISOString(),
        },
      },
      version: version + 1,
    });
    await typeAndSend(m, 'And then?');
    await flush(m, 10);
    expect(client.messages.requestService).not.toHaveBeenCalled();
    expect(m.container.textContent).toContain('The changes are being applied.');
    expect(m.container.querySelector('textarea').value).toBe('And then?');
    expect(client.records.get(KEYS.conv).value.display).toHaveLength(2);
    expect(client.records.get(KEYS.meta).value.pending.requestId).toBe('r-apply');
    expect(client.messages.attachServiceRequest.mock.calls[0][1]).toBe('r-apply');
    await m.unmount();
  });
});
