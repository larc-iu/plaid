import { describe, it, expect, vi, beforeEach } from 'vitest';

// The chat over a record only the assistant service writes, and that one tab
// at a time acts on (design/SINGLE-WRITER.md). A conversation deleted in
// another tab (H10-RECORD-5), a message sent while an approval runs
// (H10-RECORD-2), and the read-only state of a conversation another tab
// holds, with Continue here. The service's half is plaid-agent's
// test_single_writer.py.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { MemoryRouter } = await import('react-router-dom');
const { renderComponent, all } = await import('../../test/renderComponent.jsx');
const { AssistantChat } = await import('./AssistantChat.jsx');
const { jobs, serviceCache } = await import('./jobs.js');
const { fakeAssistantService } = await import('../../test/fakeAssistantService.js');

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
  extras: { tasks: ['assist'], app: 'igt', record: 2, model: 'sonnet' },
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

// The user's data as core keeps it (404 for what is gone), written only by
// the assistant.
const fakeClient = ({ meta = META, conv = CONV } = {}) => {
  const records = new Map([
    [KEYS.meta, meta],
    [KEYS.conv, conv],
  ]);
  const assistant = fakeAssistantService(records, { answer: 'Answered.' });
  const gone = () => Object.assign(new Error('Not found'), { status: 404 });
  return {
    records,
    assistant,
    messages: {
      discoverServices: vi.fn(async () => [SERVICE]),
      requestService: vi.fn(assistant.requestService),
      attachServiceRequest: vi.fn(() => new Promise(() => {})),
      cancelServiceRequest: vi.fn().mockResolvedValue({}),
    },
    userData: {
      list: vi.fn(async () =>
        [...records]
          .filter(([key]) => key.includes(':meta:'))
          .map(([key, value]) => ({ key, value })),
      ),
      get: vi.fn(async (_u, key) => {
        if (!records.has(key)) throw gone();
        return { key, value: structuredClone(records.get(key)), version: 1 };
      }),
      put: vi.fn(),
      delete: vi.fn(),
    },
    projects: { list: vi.fn().mockResolvedValue([{ id: 'p1', name: 'Lamkang A' }]) },
    server: { limits: vi.fn().mockResolvedValue({}) },
    serverNow: () => new Date(),
  };
};

const ops = (client) => client.messages.requestService.mock.calls.map((c) => c[2].op);

const button = (m, label) => all(m.container, 'button').find((b) => b.textContent.trim() === label);

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

describe('a conversation deleted in another tab (H10-RECORD-5)', () => {
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
    expect(m.container.querySelector('.overflow-y-auto').textContent).not.toContain('Still there?');
    const fresh = button(m, 'New conversation');
    expect(fresh).toBeTruthy();
    expect(client.records.has(KEYS.meta)).toBe(false);
    expect(client.userData.put).not.toHaveBeenCalled();
    await m.step(() => fresh.click());
    await flush(m);
    expect(m.container.querySelector('textarea').value).toBe('Still there?');
    expect(m.container.textContent).not.toContain('This conversation was deleted.');
    await m.unmount();
  });
});

describe('a message sent while an approval runs (H10-RECORD-2)', () => {
  it('waits in the composer, which says the changes are being applied', async () => {
    const client = fakeClient();
    const m = await mount(client);
    await flush(m);
    client.records.set(KEYS.meta, {
      ...client.records.get(KEYS.meta),
      pending: {
        kind: 'apply',
        requestId: 'r-apply',
        serviceId: SERVICE.serviceId,
        planId: 'p1',
        startedAt: new Date().toISOString(),
      },
    });
    await typeAndSend(m, 'And then?');
    await flush(m, 10);
    expect(m.container.textContent).toContain('The changes are being applied.');
    expect(m.container.querySelector('textarea').value).toBe('And then?');
    expect(client.records.get(KEYS.conv).display).toHaveLength(2);
    expect(client.userData.put).not.toHaveBeenCalled();
    await m.unmount();
  });
});

describe('a message', () => {
  it('is shown at once, sent as a request, and the service writes it', async () => {
    const client = fakeClient();
    client.assistant.hang = true;
    const m = await mount(client);
    await flush(m);
    await typeAndSend(m, 'What next?');
    await flush(m);
    expect(m.container.textContent).toContain('What next?');
    expect(m.container.querySelector('textarea').value).toBe('');
    const [send] = client.messages.requestService.mock.calls
      .map((c) => c[2])
      .filter((d) => d.op === 'send');
    expect(send).toMatchObject({ text: 'What next?', create: false });
    expect(send.tab).toBeTruthy();
    expect(client.records.get(KEYS.meta).holder.tab).toBe(send.tab);
    expect(client.records.get(KEYS.conv).display.at(-1).text).toBe('What next?');
    expect(client.userData.put).not.toHaveBeenCalled();
    await m.unmount();
  });

  it('goes back to the composer when the request ends before the service took it', async () => {
    const client = fakeClient();
    client.messages.requestService.mockImplementation(async (...a) => {
      if (a[2].op === 'send') throw Object.assign(new Error('Bad gateway'), { status: 502 });
      return client.assistant.requestService(...a);
    });
    const m = await mount(client);
    await flush(m);
    await typeAndSend(m, 'Lost on the way');
    await flush(m, 10);
    expect(m.container.querySelector('textarea').value).toBe('Lost on the way');
    expect(m.container.querySelector('.overflow-y-auto').textContent).not.toContain(
      'Lost on the way',
    );
    await m.unmount();
  });
});

describe('a first message the service never took', () => {
  it('leaves a new conversation, not a deleted one, with the text back in the composer', async () => {
    const client = fakeClient();
    client.records.clear();
    client.messages.requestService.mockImplementation(async (...a) => {
      if (a[2].op === 'send') throw Object.assign(new Error('Unavailable'), { status: 503 });
      return client.assistant.requestService(...a);
    });
    const m = await renderComponent(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <AssistantChat
          projectId="p1"
          projectName="Lamkang A"
          client={client}
          userId="u1"
          canWrite
          adapter={ADAPTER}
          conversationId={null}
        />
      </MemoryRouter>,
    );
    await flush(m);
    await typeAndSend(m, 'First words.');
    await flush(m, 10);
    expect(m.container.querySelector('textarea').value).toBe('First words.');
    expect(m.container.textContent).not.toContain('This conversation was deleted.');
    expect(m.container.querySelector('.overflow-y-auto').textContent).not.toContain('First words.');
    await m.unmount();
  });
});

describe('one tab at a time', () => {
  it('takes a conversation nobody holds when it opens it', async () => {
    const client = fakeClient();
    const m = await mount(client);
    await flush(m, 10);
    expect(ops(client)).toContain('hold');
    const [hold] = client.messages.requestService.mock.calls.map((c) => c[2]);
    expect(hold).toMatchObject({ op: 'hold' });
    expect(hold.take).toBeUndefined();
    expect(client.records.get(KEYS.meta).holder.tab).toBe(hold.tab);
    expect(m.container.textContent).not.toContain('Open in another tab.');
    await m.unmount();
  });

  it('shows a conversation another tab holds read-only, until Continue here', async () => {
    const holder = { tab: 'another-tab', at: new Date().toISOString() };
    const client = fakeClient({
      meta: { ...META, holder },
      conv: {
        ...CONV,
        display: [
          ...CONV.display,
          {
            kind: 'assistant',
            text: 'A plan.',
            plan: { id: 'plan-1', summary: '1 change', labels: ['Set a gloss'] },
            status: null,
          },
        ],
      },
    });
    const m = await mount(client);
    await flush(m, 10);
    expect(m.container.textContent).toContain('Open in another tab.');
    expect(button(m, 'Approve and apply')).toBeUndefined();
    expect(button(m, 'Discard')).toBeUndefined();
    expect(m.container.querySelector('[title="Send"]').disabled).toBe(true);
    expect(client.records.get(KEYS.meta).holder.tab).toBe('another-tab');
    await m.step(() => button(m, 'Continue here').click());
    await flush(m, 10);
    expect(client.messages.requestService.mock.calls.at(-1)[2]).toMatchObject({
      op: 'hold',
      take: true,
    });
    const mine = client.messages.requestService.mock.calls.at(-1)[2].tab;
    expect(mine).not.toBe('another-tab');
    expect(client.records.get(KEYS.meta).holder.tab).toBe(mine);
    expect(m.container.textContent).not.toContain('Open in another tab.');
    expect(button(m, 'Approve and apply')).toBeTruthy();
    await m.unmount();
  });

  it('watches a turn another tab asked without a Stop, until Continue here', async () => {
    const holder = { tab: 'another-tab', at: new Date().toISOString() };
    const pending = {
      kind: 'turn',
      requestId: 'r-live',
      serviceId: SERVICE.serviceId,
      startedAt: new Date().toISOString(),
    };
    const client = fakeClient({
      meta: { ...META, holder, pending },
      conv: {
        messages: [...CONV.messages, { role: 'user', content: 'and now?' }],
        display: [...CONV.display, { kind: 'user', text: 'and now?' }],
      },
    });
    const m = await mount(client);
    await flush(m, 10);
    expect(m.container.textContent).toContain('Open in another tab.');
    expect(m.container.textContent).toContain('Thinking');
    expect(button(m, 'Stop')).toBeUndefined();
    await m.step(() => button(m, 'Continue here').click());
    await flush(m, 10);
    expect(button(m, 'Stop')).toBeTruthy();
    await m.unmount();
  });

  it('takes a conversation whose holder stopped renewing, without a click', async () => {
    const holder = { tab: 'another-tab', at: new Date(Date.now() - 6 * 60 * 1000).toISOString() };
    const client = fakeClient({ meta: { ...META, holder } });
    const m = await mount(client);
    await flush(m, 10);
    expect(client.records.get(KEYS.meta).holder.tab).not.toBe('another-tab');
    expect(m.container.textContent).not.toContain('Open in another tab.');
    await m.unmount();
  });

  it('turns read-only, keeping the text, when another tab took it meanwhile', async () => {
    const client = fakeClient();
    const m = await mount(client);
    await flush(m, 10);
    client.records.set(KEYS.meta, {
      ...client.records.get(KEYS.meta),
      holder: { tab: 'another-tab', at: new Date().toISOString() },
    });
    await typeAndSend(m, 'Mine?');
    await flush(m, 10);
    expect(m.container.querySelector('textarea').value).toBe('Mine?');
    expect(m.container.textContent).toContain('Open in another tab.');
    expect(client.records.get(KEYS.conv).display).toHaveLength(2);
    await m.unmount();
  });
});

describe('the size meter', () => {
  it('reads the size the service wrote on the entry', async () => {
    const client = fakeClient({ meta: { ...META, size: { bytes: 900, cap: 1000 } } });
    const m = await mount(client);
    await flush(m, 10);
    expect(m.container.textContent).toContain('This conversation is full.');
    await m.unmount();
  });
});
