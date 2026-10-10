import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from './renderComponent.jsx';
import { documentsBundle } from './fakeClient.js';
import { fakeAssistantService } from './fakeAssistantService.js';
import { AssistantChat } from '../components/assistant/AssistantChat.jsx';

// What the suites that mount the whole chat share: an igt adapter, one online
// assistant, one saved conversation's meta, a client over the records only
// the assistant writes, the mount and the waits. Each suite keeps only its
// own conversation and whatever of the client it changes.

export const ADAPTER = {
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

export const SERVICE = {
  serviceId: 'igt:assist:one',
  serviceName: 'Assistant one',
  online: true,
  extras: { tasks: ['assist'], app: 'igt', record: 3, model: 'sonnet' },
};

export const META = {
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

export const KEYS = { meta: 'igt:assistant:p1:meta:c1', conv: 'igt:assistant:p1:conv:c1' };

/**
 * A client holding conversation c1 of project p1 (`meta`, `conv`), whose
 * assistant (`client.assistant`, fakeAssistantService) writes the records the
 * page reads. `where`: what discovery answers for a project other than p1.
 * `answer`: the model's answer to a turn. `projects`: the project listing.
 */
export function chatClient({
  conv,
  meta = META,
  service = SERVICE,
  where = {},
  answer,
  projects = [{ id: 'p1', name: 'Lamkang A' }],
} = {}) {
  const records = new Map([
    [KEYS.meta, meta],
    [KEYS.conv, conv],
  ]);
  const assistant = fakeAssistantService(records, answer === undefined ? undefined : { answer });
  return {
    records,
    assistant,
    messages: {
      discoverServices: vi.fn(async (pid) => (pid === 'p1' ? [service] : (where[pid] ?? []))),
      requestService: vi.fn(assistant.requestService),
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
      list: vi.fn().mockResolvedValue(projects),
      ...documentsBundle(),
    },
  };
}

/** The chat on project p1, showing `conversationId`, with `props` on top. */
export const mountChat = (client, { conversationId = 'c1', ...props } = {}) =>
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
        {...props}
      />
    </MemoryRouter>,
  );

/** Let the reads a mount starts, and the promise chain behind a job, run out. */
export const flush = async (m, times = 4) => {
  for (let i = 0; i < times; i++)
    await m.step(() => new Promise((resolve) => setTimeout(resolve, 0)));
};

/** `value` typed into the composer and sent with Enter. */
export const typeAndSend = (m, value) =>
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
