import { describe, it, expect, vi, beforeEach } from 'vitest';

// The surfaces themselves, mounted: AssistantChat and the two things built on
// it. The hooks under them are covered on their own, and every one of these
// takes as a parameter what the surface hands it, so a hook test proves the
// hook and not the wiring. Three props had one call site each and nothing
// mounting them: dropping `toastOnApply={false}` puts a success toast back over
// the docked composer, dropping `resumeNewest` loses the settled rule that the
// panel comes back to the thread the reader was in, and `onConversationId` had
// no default at all, so a surface that tracks no conversation threw on the
// first delete.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { notifySuccess, notifyError } = await import('../../lib/notify.js');
const { MemoryRouter } = await import('react-router-dom');
const { renderComponent, byText } = await import('../../test/renderComponent.jsx');
const { documentsBundle } = await import('../../test/fakeClient.js');
const { AssistantChat } = await import('./AssistantChat.jsx');
const { AssistantPanel } = await import('./AssistantPanel.jsx');
const { AssistantTab } = await import('./AssistantTab.jsx');
const { jobs, lastOpen, serviceCache } = await import('./jobs.js');

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

// One saved conversation with a plan still to decide, which is what the apply
// tests press.
const CONV = {
  messages: [{ role: 'user', content: 'gloss it' }],
  display: [
    { kind: 'user', text: 'gloss it' },
    {
      kind: 'assistant',
      text: 'Here is what I would change.',
      plan: { id: 'plan-1', summary: '1 change', labels: ['Set a gloss'] },
      status: null,
    },
  ],
};

const fakeClient = () => {
  const records = new Map([
    ['igt:assistant:p1:meta:c1', META],
    ['igt:assistant:p1:conv:c1', CONV],
  ]);
  return {
    records,
    messages: {
      discoverServices: vi.fn().mockResolvedValue([SERVICE]),
      requestService: vi.fn().mockResolvedValue({ message: 'Applied 1 change.' }),
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
      list: vi.fn().mockResolvedValue([]),
      ...documentsBundle(),
    },
  };
};

const base = (client) => ({
  projectId: 'p1',
  client,
  userId: 'u1',
  canWrite: true,
  adapter: ADAPTER,
});

const mount = (element, at = '/projects/p1') =>
  renderComponent(<MemoryRouter initialEntries={[at]}>{element}</MemoryRouter>);

// Let the reads a mount starts, and the promise chain behind a job, run out.
const flush = async (m, times = 4) => {
  for (let i = 0; i < times; i++)
    await m.step(() => new Promise((resolve) => setTimeout(resolve, 0)));
};

// What `compact` reaches, which is three class names and nothing else: the
// chat's own card, the transcript's padding and the composer's.
const shell = (m) => {
  const section = m.container.querySelector('section');
  return {
    card: section.className,
    transcript: section.querySelector('.overflow-y-auto').className,
    composer: section.querySelector('.border-t').className,
  };
};

const approve = async (m) => {
  const button = byText(m.container, 'button', 'Approve and apply');
  expect(button).not.toBeNull();
  await m.step(() => button.click());
  for (let i = 0; i < 20 && jobs.size; i++) await flush(m, 1);
};

beforeEach(() => {
  jobs.clear();
  lastOpen.clear();
  serviceCache.clear();
  vi.clearAllMocks();
});

describe('AssistantPanel', () => {
  it('comes back to the project’s newest thread', async () => {
    // Settled decision 1: the panel is chrome, it comes back on every screen
    // and every visit, and a blank conversation each time means going to find
    // what you were in the middle of.
    const client = fakeClient();
    const m = await mount(<AssistantPanel {...base(client)} projectName="A project" />);
    await flush(m);
    expect(m.container.textContent).toContain('gloss it');
    expect(m.container.textContent).not.toContain('Ask about A project');
    await m.unmount();
  });

  it('applies a plan without a success toast over the composer', async () => {
    const client = fakeClient();
    const m = await mount(<AssistantPanel {...base(client)} projectName="A project" />);
    await flush(m);
    await approve(m);
    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    expect(client.messages.requestService.mock.calls[0][2].approve).toMatchObject({
      planId: 'plan-1',
    });
    expect(notifySuccess).not.toHaveBeenCalled();
    await m.unmount();
  });

  it('names the assistant answering from the bag', async () => {
    const client = fakeClient();
    const m = await mount(<AssistantPanel {...base(client)} projectName="A project" />);
    await flush(m);
    // The conversation is bound to one assistant, so the panel shows its model
    // rather than the picker.
    expect(m.container.textContent).toContain('sonnet');
    await m.unmount();
  });

  it('draws no card of its own and pads a narrow column tightly', async () => {
    // `compact`: the dock around the chat already draws a border, and a third
    // of a screen cannot spare the tab's padding.
    const client = fakeClient();
    const m = await mount(<AssistantPanel {...base(client)} projectName="A project" />);
    await flush(m);
    const s = shell(m);
    expect(s.card).not.toContain('border');
    expect(s.card).toContain('min-h-0');
    expect(s.transcript).toContain('px-3');
    expect(s.composer).toContain('px-3');
    await m.unmount();
  });
});

describe('AssistantTab', () => {
  it('opens a new conversation rather than the newest thread', async () => {
    // The tab opens new the way a chat app does: its rail puts every thread one
    // click away.
    const client = fakeClient();
    const m = await mount(
      <AssistantTab {...base(client)} projectName="A project" />,
      '/projects/p1?tab=assistant',
    );
    await flush(m);
    expect(m.container.textContent).toContain('Ask about this project.');
    expect(m.container.textContent).not.toContain('Here is what I would change.');
    await m.unmount();
  });

  it('applies a plan and says so', async () => {
    const client = fakeClient();
    const m = await mount(
      <AssistantTab {...base(client)} projectName="A project" />,
      '/projects/p1?tab=assistant&conversation=c1',
    );
    await flush(m);
    await approve(m);
    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    expect(notifySuccess).toHaveBeenCalledTimes(1);
    await m.unmount();
  });

  it('names the assistant answering from the bag', async () => {
    const client = fakeClient();
    const m = await mount(
      <AssistantTab {...base(client)} projectName="A project" />,
      '/projects/p1?tab=assistant',
    );
    await flush(m);
    expect(m.container.textContent).toContain('Assistant one');
    await m.unmount();
  });

  it('draws its own card and the full padding, standing on a page', async () => {
    const client = fakeClient();
    const m = await mount(
      <AssistantTab {...base(client)} projectName="A project" />,
      '/projects/p1?tab=assistant',
    );
    await flush(m);
    const s = shell(m);
    expect(s.card).toContain('rounded-lg border');
    expect(s.card).not.toContain('min-h-0');
    expect(s.transcript).toContain('px-4');
    expect(s.composer).toContain('px-4');
    await m.unmount();
  });
});

describe('AssistantChat with no way to track the conversation', () => {
  it('survives deleting the conversation it is showing', async () => {
    const client = fakeClient();
    const m = await mount(
      <AssistantChat
        {...base(client)}
        conversationId="c1"
        renderSidebar={({ listProps }) => (
          <button
            type="button"
            data-testid="delete"
            onClick={() => listProps.onDelete(listProps.rows[0])}
          />
        )}
      />,
    );
    await flush(m);
    expect(m.container.textContent).toContain('gloss it');
    await m.step(() => m.container.querySelector('[data-testid="delete"]').click());
    await flush(m);
    expect(client.userData.delete).toHaveBeenCalledTimes(2);
    expect(m.container.textContent).not.toContain('gloss it');
    expect(notifyError).not.toHaveBeenCalled();
    await m.unmount();
  });

  it('survives a link to a conversation that cannot be read', async () => {
    const client = fakeClient();
    client.userData.get.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    const m = await mount(<AssistantChat {...base(client)} conversationId="c1" />);
    await flush(m);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(m.container.textContent).not.toContain('gloss it');
    await m.unmount();
  });
});

// Attaching a file and sending it, mounted, because the ORDER is the contract:
// the parts are stored before the record names them, so a message never goes
// out pointing at a file that is not there.
describe('AssistantChat attachments', () => {
  const TEXT = 'word,translation\nnis,milk\n';
  const FILE = { name: 'wordlist.csv', size: TEXT.length, text: async () => TEXT };

  const drop = (m, files) =>
    m.step(() => {
      const e = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { files, types: ['Files'] } });
      m.container.querySelector('textarea').dispatchEvent(e);
    });

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

  it('stores the file before the message that names it, and sends only the reference', async () => {
    const client = fakeClient();
    const m = await mount(<AssistantChat {...base(client)} conversationId="c1" />);
    await flush(m);
    await drop(m, [FILE]);
    await flush(m);
    expect(m.container.textContent).toContain('wordlist.csv');
    await typeAndSend(m, 'which of these are new?');
    await flush(m, 8);

    const puts = client.userData.put.mock.calls.map((c) => c[1]);
    const part = puts.findIndex((k) => k.startsWith('igt:assistant:p1:file:c1:'));
    const record = puts.indexOf('igt:assistant:p1:conv:c1');
    expect(part).toBeGreaterThanOrEqual(0);
    expect(part).toBeLessThan(record);
    expect(client.records.get(puts[part])).toBe(TEXT);

    const sent = client.userData.put.mock.calls[record][2];
    const asked = sent.display.at(-1);
    expect(asked).toMatchObject({ kind: 'user', text: 'which of these are new?' });
    expect(asked.files).toEqual([
      expect.objectContaining({ name: 'wordlist.csv', bytes: TEXT.length, lines: 2, chunks: 1 }),
    ]);
    expect(JSON.stringify(sent)).not.toContain('nis,milk');
    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    await m.unmount();
  });

  it('sends nothing when the file cannot be stored, and keeps the message and the file', async () => {
    const client = fakeClient();
    const put = client.userData.put.getMockImplementation();
    client.userData.put.mockImplementation(async (userId, key, value) => {
      if (key.includes(':file:')) throw Object.assign(new Error('too large'), { status: 413 });
      return put(userId, key, value);
    });
    const m = await mount(<AssistantChat {...base(client)} conversationId="c1" />);
    await flush(m);
    await drop(m, [FILE]);
    await flush(m);
    await typeAndSend(m, 'which of these are new?');
    await flush(m, 8);
    expect(client.messages.requestService).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalled();
    expect(m.container.querySelector('textarea').value).toBe('which of these are new?');
    expect(m.container.querySelector('[aria-label="Remove wordlist.csv"]')).not.toBeNull();
    await m.unmount();
  });

  it('refuses a file it cannot read, and says why', async () => {
    const client = fakeClient();
    const m = await mount(<AssistantChat {...base(client)} conversationId="c1" />);
    await flush(m);
    await drop(m, [{ name: 'photo.png', size: 10, text: async () => '' }]);
    await flush(m);
    expect(notifyError).toHaveBeenCalledWith(expect.stringContaining('It reads text'));
    expect(m.container.querySelector('[aria-label="Remove photo.png"]')).toBeNull();
    await m.unmount();
  });
});
