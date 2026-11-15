import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, byText, all } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';

// The job page's list of the job's work (BRIEF LV, "Work so far" while it runs, "Work, in order" once it has ended): a row per piece of the job's work as its
// worker summed it up, newest first and the plan last, read again with each
// read of the job, capped at the tall list's page with Show more, kept above
// the report once the job has ended. And each document's Changes link while
// the job runs says it is so far.
const auth = vi.hoisted(() => ({ user: { id: 'w', isAdmin: false } }));
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/utils/feedback', () => ({ notifyError: vi.fn() }));
const { JobPage } = await import('./JobPage.jsx');
const { JOB_POLL_MS } = await import('@ui/domain/jobs.js');
const { TALL_LIST_PAGE_SIZE } = await import('@ui/hooks/usePagedList.js');

const PROJECT = { id: 'p1', maintainers: ['m'], writers: ['w'], readers: [], vocabs: [] };

const jobOf = (over = {}) => ({
  id: 'j1',
  project: 'p1',
  app: 'igt',
  instructions: 'Fill the gloss.',
  startedBy: 'w',
  startedByName: 'Wren',
  state: 'running',
  phase: 'working',
  message: 'Sentences 3 to 4 of 4. 2 steps in this piece.',
  createdAt: '2026-11-12T10:00:00Z',
  startedAt: '2026-11-12T10:01:00Z',
  finishedAt: null,
  documents: [
    {
      documentId: 'd1',
      name: 'Story A',
      position: 0,
      state: 'working',
      targets: 4,
      done: 2,
      counts: { words: 4, changes: 6 },
      glossGroup: 'g-d1',
      skipped: [],
    },
    { documentId: 'd2', name: null, position: 1, state: 'gone', counts: {}, skipped: [] },
  ],
  report: null,
  ...over,
});

const PLAN = {
  seq: '000000',
  piece: {
    plan: { by: 'model', pieces: 'sentences', fillsNames: ['Gloss'] },
    steps: 3,
    endedAt: '2026-11-12T10:02:00Z',
  },
};
const FIRST = {
  seq: '000001',
  piece: {
    piece: 'k1',
    document: 'd1',
    name: 'Story A',
    first: 's1',
    last: 's2',
    firstId: 'sen1',
    whole: false,
    counts: { analyzed: 2, words: 4, changes: 6 },
    fields: [{ field: 'Gloss', id: 'L1', values: 2 }],
    note: 'Glossed s1 and s2.\nLeft s2.w3: no precedent.',
    steps: 2,
    endedAt: '2026-11-12T10:03:00Z',
  },
};
const SECOND = {
  seq: '000002',
  piece: {
    piece: 'k2',
    document: 'd1',
    name: 'Story A',
    first: 's3',
    last: 's3',
    firstId: 'sen3',
    whole: false,
    counts: {},
    skipped: [
      { sentence: 's3', sentenceId: 'sen3', reason: 'no-answer', kind: null, documentId: 'd1' },
    ],
    refused: [{ sentence: 's3', sentenceId: 'sen3', what: 'x', code: 'shape', document: 'd1' }],
    note: '',
    steps: 4,
    endedAt: '2026-11-12T10:04:00Z',
  },
};

const page = (entries, nextCursor = null) => ({ entries, nextCursor });

const clientOf = (jobs, pages) => {
  let j = 0;
  let p = 0;
  return {
    jobs: {
      get: vi.fn(async () => jobs[Math.min(j++, jobs.length - 1)]),
      piecesPage: vi.fn(async () => pages[Math.min(p++, pages.length - 1)]),
      cancel: vi.fn(),
    },
    messages: { discoverServices: vi.fn(async () => []) },
  };
};

const mount = (client) =>
  renderComponent(
    <MemoryRouter>
      <ConfirmProvider>
        <JobPage project={PROJECT} projectId="p1" jobId="j1" client={client} />
      </ConfirmProvider>
    </MemoryRouter>,
  );

const activity = (root) =>
  root.querySelector('section[aria-label="Work so far"], section[aria-label="Work, in order"]');
const rows = (root) => all(activity(root), '[data-testid="job-activity"] > li');
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  auth.user = { id: 'w', isAdmin: false };
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe('the job page’s list of its work', () => {
  it('says nothing has finished yet while the job runs with no piece', async () => {
    const client = clientOf(
      [jobOf({ phase: 'planning', message: 'Planning the work. 1 step.' })],
      [page([])],
    );
    const v = await mount(client);
    expect(byText(activity(v.container), 'p', 'Nothing finished yet.')).toBeTruthy();
    expect(client.jobs.piecesPage).toHaveBeenCalledWith('j1', { limit: TALL_LIST_PAGE_SIZE });
    expect(text(v.container)).toContain('Planning the work. 1 step.');
    expect(activity(v.container).getAttribute('aria-label')).toBe('Work so far');
    await v.unmount();
  });

  it('fills in as pieces finish, newest first, the plan last, keeping the rows it shows', async () => {
    vi.useFakeTimers();
    const client = clientOf(
      [jobOf()],
      [page([]), page([PLAN]), page([FIRST, PLAN]), page([SECOND, FIRST, PLAN])],
    );
    const v = await mount(client);
    expect(rows(v.container)).toHaveLength(0);
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    expect(rows(v.container).map(text)).toEqual([expect.stringContaining('Plan')]);
    expect(text(rows(v.container)[0])).toContain('Worked in stretches of sentences. Fills: Gloss.');
    expect(text(rows(v.container)[0])).toContain('3 steps');
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    const planRow = rows(v.container)[1];
    expect(rows(v.container).map((li) => li.dataset.seq)).toEqual(['000001', '000000']);
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    expect(rows(v.container).map((li) => li.dataset.seq)).toEqual(['000002', '000001', '000000']);
    expect(rows(v.container)[2]).toBe(planRow);
    const [second, first] = rows(v.container);
    // Where, as a link into the grid at its first sentence.
    expect(byText(first, 'a', 'Story A s1 to s2').getAttribute('href')).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=sen1',
    );
    expect(text(first)).toContain(
      'Sentences written in: 2, Changes written: 6, Words analyzed: 4, Gloss: 2 values.',
    );
    expect(text(first)).toContain('2 steps');
    // The note in full, as written.
    expect(first.querySelector('p[dir="auto"]').textContent).toBe(
      'Glossed s1 and s2.\nLeft s2.w3: no precedent.',
    );
    expect(byText(second, 'a', 'Story A s3')).toBeTruthy();
    expect(text(second)).toContain('Nothing written.');
    expect(all(second, 'p').map(text)).toEqual(
      expect.arrayContaining(['Skipped:', 'Not done, refused:']),
    );
    expect(all(second, 'li').map(text)).toEqual([
      's3 No answer from the assistant',
      's3 Retype, split, merge or delete of words the job also changed',
    ]);
    expect(byText(second, 'a', 's3').getAttribute('href')).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=sen3',
    );
    expect(second.querySelector('p[dir="auto"]')).toBe(null);
    await v.unmount();
  });

  it('shows the newest page and more on Show more', async () => {
    const client = clientOf([jobOf()], [page([SECOND, FIRST], 'c'), page([SECOND, FIRST, PLAN])]);
    const v = await mount(client);
    expect(rows(v.container)).toHaveLength(2);
    await v.step(() => byText(activity(v.container), 'button', 'Show more').click());
    expect(client.jobs.piecesPage).toHaveBeenLastCalledWith('j1', {
      limit: 2 * TALL_LIST_PAGE_SIZE,
    });
    expect(rows(v.container)).toHaveLength(3);
    expect(all(activity(v.container), 'button')).toHaveLength(0);
    await v.unmount();
  });

  it('names a piece of a deleted document so, with no link', async () => {
    const gone = {
      seq: '000003',
      piece: { ...FIRST.piece, document: 'd2', name: 'Story B', firstId: 'x' },
    };
    const v = await mount(clientOf([jobOf()], [page([gone])]));
    expect(text(rows(v.container)[0])).toContain('Deleted document');
    expect(all(rows(v.container)[0], 'a')).toHaveLength(0);
    await v.unmount();
  });

  it('keeps the rows above the report once the job has ended', async () => {
    const ended = jobOf({
      state: 'done',
      finishedAt: '2026-11-12T11:00:00Z',
      report: { totals: { documentsDone: 1, sentences: 2 }, documents: [] },
    });
    const v = await mount(clientOf([ended], [page([FIRST, PLAN])]));
    expect(rows(v.container)).toHaveLength(2);
    expect(activity(v.container).getAttribute('aria-label')).toBe('Work, in order');
    const report = v.container.querySelector('section[aria-label="Report"]');
    expect(
      activity(v.container).compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await v.unmount();
  });

  it('shows nothing for an ended job whose worker kept no summary, one started from the form', async () => {
    const ended = jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z', setup: undefined });
    const v = await mount(clientOf([ended], [page([])]));
    expect(activity(v.container)).toBe(null);
    await v.unmount();
  });

  it('says a document’s Changes are so far while the job runs', async () => {
    const v = await mount(clientOf([jobOf()], [page([])]));
    const link = byText(v.container, 'a', 'Changes so far');
    expect(link.getAttribute('href')).toBe('/projects/p1/documents/d1?history=g-d1');
    await v.unmount();
    const ended = jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z' });
    const w = await mount(clientOf([ended], [page([])]));
    expect(byText(w.container, 'a', 'Changes').getAttribute('href')).toBe(
      '/projects/p1/documents/d1?history=g-d1',
    );
    await w.unmount();
  });

  it('marks a row the worker cut with …', async () => {
    const cut = { seq: '000004', piece: { ...FIRST.piece, cut: true, fields: [] } };
    const v = await mount(clientOf([jobOf()], [page([cut])]));
    expect(all(rows(v.container)[0], 'p').map(text)).toContain('…');
    await v.unmount();
  });

  it('says once the job has ended that some finished work is not listed, when the rows count less', async () => {
    const ended = jobOf({
      state: 'done',
      finishedAt: '2026-11-12T11:00:00Z',
      report: { totals: { documentsDone: 1, sentences: 2 }, documents: [] },
    });
    const short = await mount(clientOf([ended], [page([FIRST, PLAN])]));
    // The document counts 4 words and 6 changes, the row 4 and 6: nothing short.
    expect(short.container.querySelector('[data-testid="job-activity-short"]')).toBe(null);
    await short.unmount();
    const more = jobOf({
      ...ended,
      documents: [{ ...ended.documents[0], counts: { words: 7, changes: 6 } }],
    });
    const v = await mount(clientOf([more], [page([FIRST, PLAN])]));
    expect(text(v.container.querySelector('[data-testid="job-activity-short"]'))).toBe(
      'Some finished work is not listed here. The report below counts all of it.',
    );
    await v.unmount();
    // Not while the job runs.
    const w = await mount(clientOf([jobOf({ documents: more.documents })], [page([FIRST, PLAN])]));
    expect(w.container.querySelector('[data-testid="job-activity-short"]')).toBe(null);
    await w.unmount();
  });
});
