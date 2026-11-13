import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';
import { AssistantSubjectProvider } from '@ui/components/assistant/AssistantSubject.jsx';
import { useAssistantFresh, useAssistantScope } from '@ui/components/assistant/subject.js';
import { serviceCache } from '@ui/components/assistant/jobs.js';

// A job's page is a place the assistant reads (BRIEF-JD): the panel's turns are
// asked from the job, and an ended job with a report offers a new conversation
// about it, where an assistant is online and the window has room for the
// panel. A running job does not.
const auth = vi.hoisted(() => ({ user: { id: 'r', isAdmin: false } }));
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/utils/feedback', () => ({ notifyError: vi.fn() }));
const { JobPage } = await import('./JobPage.jsx');

const PROJECT = {
  id: 'p1',
  name: 'Kukama',
  maintainers: ['m'],
  writers: ['w'],
  readers: ['r'],
  vocabs: [],
};

const REPORT = {
  state: 'done',
  instructions: 'Gloss the words.',
  totals: { documentsDone: 1, sentences: 1, words: 1 },
  documents: [],
  harmonize: { changed: [], left: [] },
  entries: { created: [] },
};

const jobOf = (over = {}) => ({
  id: 'j1',
  project: 'p1',
  app: 'igt',
  instructions: 'Gloss the words.',
  startedBy: 'w',
  startedByName: 'Wren',
  state: 'done',
  phase: null,
  reason: null,
  message: null,
  createdAt: '2026-11-12T10:00:00Z',
  startedAt: '2026-11-12T10:01:00Z',
  finishedAt: '2026-11-12T11:00:00Z',
  documents: [],
  report: REPORT,
  ...over,
});

const ASSISTANT = {
  serviceId: 'igt:assist:m',
  online: true,
  extras: { tasks: ['assist'], app: 'igt', record: 3 },
};

const clientOf = (job, services = [ASSISTANT]) => ({
  jobs: { get: vi.fn(async () => job), cancel: vi.fn() },
  messages: { discoverServices: vi.fn(async () => services) },
});

// What the panel sees: the subject the page published and the request.
const Panel = ({ seen }) => {
  const subject = useAssistantScope();
  const { fresh } = useAssistantFresh();
  seen.push({ subject, fresh });
  return null;
};

const mount = async (client, seen = []) => {
  const m = await renderComponent(
    <MemoryRouter>
      <ConfirmProvider>
        <AssistantSubjectProvider>
          <Panel seen={seen} />
          <JobPage project={PROJECT} projectId="p1" jobId="j1" client={client} />
        </AssistantSubjectProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );
  for (let i = 0; i < 4; i++) await m.step(() => new Promise((r) => setTimeout(r, 0)));
  return m;
};

const discuss = (root) =>
  all(root, 'button').find((b) => b.textContent.trim() === 'Discuss with the assistant') ?? null;

beforeEach(() => {
  serviceCache.clear();
  auth.user = { id: 'r', isAdmin: false };
  window.innerWidth = 1280;
});

describe('the job page and the assistant', () => {
  it('tells the panel it is about the job, by its id and when it was started', async () => {
    const seen = [];
    const m = await mount(clientOf(jobOf()), seen);
    const { subject } = seen.at(-1);
    expect(subject).toMatchObject({
      projectId: 'p1',
      projectName: 'Kukama',
      kind: 'job',
      id: 'j1',
    });
    expect(subject.name).toMatch(/^Job of .*2026/);
    await m.unmount();
  });

  it('offers a new conversation about an ended job, to a reader too, and asks the panel for one', async () => {
    for (const state of ['done', 'cancelled', 'failed']) {
      serviceCache.clear();
      const seen = [];
      const m = await mount(clientOf(jobOf({ state })), seen);
      const button = discuss(m.container);
      expect(button, state).not.toBeNull();
      expect(seen.at(-1).fresh).toBeNull();
      await m.step(() => button.click());
      expect(seen.at(-1).fresh).not.toBeNull();
      await m.unmount();
    }
  });

  it('offers none for a job under way, one with no report, or where no panel can open', async () => {
    const cases = [
      clientOf(jobOf({ state: 'running', finishedAt: null, report: null })),
      clientOf(jobOf({ state: 'waiting', finishedAt: null, startedAt: null, report: null })),
      clientOf(jobOf({ state: 'failed', report: null })),
      clientOf(jobOf(), []),
    ];
    for (const client of cases) {
      serviceCache.clear();
      const m = await mount(client);
      expect(discuss(m.container)).toBeNull();
      await m.unmount();
    }
    window.innerWidth = 800;
    window.dispatchEvent(new Event('resize'));
    const m = await mount(clientOf(jobOf()));
    expect(discuss(m.container)).toBeNull();
    await m.unmount();
  });
});
