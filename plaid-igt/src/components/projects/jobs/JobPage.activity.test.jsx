import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, byText, all } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';

// The job page's list of the job's work (BRIEF LV, "Work so far" while it runs, "Work, in order" once it has ended): a row per piece of the job's work as its
// worker summed it up, newest first, read again with each read of the job,
// capped at the tall list's page with Show more, kept above the report once
// the job has ended. The plan's row is the page's Plan line above the list,
// from the moment planning ends (RPF-P4). And each document's Changes link
// while the job runs says it is so far.
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
  message: 'Sentences 3 to 4 of 4. 2 steps in this part.',
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
// The job's facts, label to value.
const facts = (root) =>
  Object.fromEntries(
    all(root, 'dl dt').map((dt) => [dt.textContent, dt.nextElementSibling.textContent]),
  );

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

  it('fills in as pieces finish, newest first, the plan above the list, keeping the rows it shows', async () => {
    vi.useFakeTimers();
    const client = clientOf(
      [jobOf()],
      [page([]), page([PLAN]), page([FIRST, PLAN]), page([SECOND, FIRST, PLAN])],
    );
    const v = await mount(client);
    expect(rows(v.container)).toHaveLength(0);
    expect(facts(v.container).Plan).toBeUndefined();
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    // RP-9: the plan, the one statement of what a job from the form fills,
    // while the job runs, above the list and not in it.
    expect(rows(v.container)).toHaveLength(0);
    expect(facts(v.container).Plan).toBe('Worked in stretches of sentences. Fills: Gloss.');
    const plan = byText(v.container, 'dt', 'Plan');
    expect(
      plan.compareDocumentPosition(activity(v.container)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    const firstRow = rows(v.container)[0];
    expect(rows(v.container).map((li) => li.dataset.seq)).toEqual(['000001']);
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    expect(rows(v.container).map((li) => li.dataset.seq)).toEqual(['000002', '000001']);
    expect(rows(v.container)[1]).toBe(firstRow);
    const [second, first] = rows(v.container);
    // Where, as a link into the grid at its first sentence.
    expect(byText(first, 'a', 'Story A s1 to s2').getAttribute('href')).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=sen1',
    );
    expect(text(first)).toContain(
      'Sentences written in: 2, Changes written: 6, Words analyzed: 4, Gloss: 2 values.',
    );
    expect(text(first)).toContain('2 steps');
    // The note in full, as the chat renders the assistant's text.
    const note = first.querySelector('[dir="auto"]');
    expect(text(note)).toBe('Glossed s1 and s2.Left s2.w3: no precedent.');
    expect(note.querySelector('br')).not.toBeNull();
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
    expect(second.querySelector('[dir="auto"]')).toBe(null);
    await v.unmount();
  });

  it('shows the newest page and more on Show more, and reads the plan once past the first page', async () => {
    const client = clientOf(
      [jobOf()],
      [page([SECOND, FIRST], 'c'), page([SECOND, FIRST, PLAN]), page([SECOND, FIRST, PLAN])],
    );
    const v = await mount(client);
    expect(rows(v.container)).toHaveLength(2);
    // The plan's row is the oldest: read once, at the route's cap.
    expect(client.jobs.piecesPage).toHaveBeenNthCalledWith(2, 'j1', { limit: 1000 });
    expect(facts(v.container).Plan).toBe('Worked in stretches of sentences. Fills: Gloss.');
    await v.step(() => byText(activity(v.container), 'button', 'Show more').click());
    expect(client.jobs.piecesPage).toHaveBeenLastCalledWith('j1', {
      limit: 2 * TALL_LIST_PAGE_SIZE,
    });
    expect(client.jobs.piecesPage).toHaveBeenCalledTimes(3);
    expect(rows(v.container)).toHaveLength(2);
    expect(all(activity(v.container), 'button')).toHaveLength(0);
    await v.unmount();
  });

  it('says what a piece’s text edits did to the words', async () => {
    const edited = {
      seq: '000005',
      piece: {
        ...FIRST.piece,
        counts: { analyzed: 1, changes: 3, textChanges: 1, wordsAdded: 2, tokensChanged: 1 },
        changesParts: [
          { kind: 'values', n: 2 },
          { kind: 'text', n: 1 },
        ],
        fields: [],
      },
    };
    const v = await mount(clientOf([jobOf()], [page([edited])]));
    expect(text(rows(v.container)[0])).toContain(
      'Sentences written in: 1, Changes written: 3 (2 values and 1 text edit), Changes to the text: 1, Words added: 2, Existing words or punctuation marks changed or removed: 1.',
    );
    await v.unmount();
  });

  // BRIEF RW B5, REV-RW-7: a piece that did not finish says how it ended and
  // what followed it, true whatever happened after.
  it('says how a piece that did not finish ended and what followed it', async () => {
    const whole = {
      ...FIRST.piece,
      first: null,
      last: null,
      firstId: null,
      whole: true,
      fields: [],
    };
    const at = (seq, piece) => ({ seq, piece: { ...piece, piece: `k${seq}` } });
    const v = await mount(
      clientOf(
        [jobOf()],
        [
          page([
            at('000010', { ...whole, counts: {}, note: '', failed: 'budget' }),
            at('000011', { ...whole, counts: {}, note: '', failed: 'no-answer' }),
            at('000012', { ...FIRST.piece, ended: 'budget' }),
            at('000013', { ...FIRST.piece, counts: {}, fields: [], ended: 'budget' }),
            at('000014', { ...whole, ended: 'output', rest: 1 }),
            at('000015', { ...whole, document: null, counts: {}, note: '', failed: 'budget' }),
          ]),
        ],
      ),
    );
    const lines = rows(v.container).map((r) =>
      all(r, '[data-testid="piece-end"]').map((p) => text(p)),
    );
    expect(lines).toEqual([
      ['Failed: over budget.', 'Worked again in stretches of sentences.'],
      ['No answer from the assistant.', 'Worked again in stretches of sentences.'],
      ['Steps used up: written as staged.'],
      ['Steps used up: what it had staged was not written.'],
      ['Answer too long: written as staged.', 'The rest worked in stretches of sentences.'],
      // d2 of the job's two documents is deleted.
      ['Failed: over budget.', '1 document of 2 worked again in stretches of sentences.'],
    ]);
    await v.unmount();
  });

  it('says a document that then ended in use or deleted was not worked again', async () => {
    const whole = {
      ...FIRST.piece,
      first: null,
      last: null,
      firstId: null,
      whole: true,
      fields: [],
    };
    const job = jobOf({
      documents: [{ ...jobOf().documents[0], state: 'in-use' }, jobOf().documents[1]],
    });
    const v = await mount(
      clientOf(
        [job],
        [
          page([
            {
              seq: '000020',
              piece: { ...whole, piece: 'k20', counts: {}, note: '', failed: 'budget' },
            },
            {
              seq: '000021',
              piece: {
                ...whole,
                piece: 'k21',
                document: 'd2',
                counts: {},
                note: '',
                failed: 'output',
              },
            },
          ]),
        ],
      ),
    );
    const lines = rows(v.container).map((r) =>
      all(r, '[data-testid="piece-end"]').map((p) => text(p)),
    );
    expect(lines).toEqual([
      ['Failed: over budget.', 'Not worked again: in use.'],
      ['Failed: answer too long.', 'Not worked again: deleted.'],
    ]);
    await v.unmount();
  });

  // RPF3-B: the piece after a text edit is a row of its own, named by what it
  // took.
  it('names a piece after a text edit by what it took', async () => {
    const after = (seq, afterText) => ({
      seq,
      piece: { ...FIRST.piece, piece: `k${seq}`, last: 's5', afterText },
    });
    const v = await mount(
      clientOf([jobOf()], [page([after('000007', 'added'), after('000008', 'edited')])]),
    );
    const where = rows(v.container).map((r) => text(r.querySelector('a')));
    expect(where).toEqual([
      'Story A s1 to s5, the words added',
      'Story A s1 to s5, after the text edit',
    ]);
    await v.unmount();
  });

  // SF round 2 (RP4-4 finding 3): a piece's note is the model's text, labelled
  // once above the list as the page labels the summary.
  it('labels the pieces’ notes as the assistant’s, not checked', async () => {
    const v = await mount(clientOf([jobOf()], [page([FIRST])]));
    const section = v.container.querySelector(
      'section[aria-label="Work so far"], section[aria-label="Work, in order"]',
    );
    expect(text(section)).toContain(
      'Notes written by the assistant, not checked against the counts.',
    );
    await v.unmount();
  });

  // SF: a piece of a plan limited by a search names its sentences, which are
  // no run.
  it('names the sentences of a piece of a plan limited by a search', async () => {
    const piece = {
      seq: '000009',
      piece: {
        ...FIRST.piece,
        piece: 'k9',
        first: 's3',
        last: 's14',
        matching: ['s3', 's8', 's14'],
      },
    };
    const v = await mount(clientOf([jobOf()], [page([piece])]));
    expect(text(rows(v.container)[0].querySelector('a'))).toBe(
      'Story A s3, s8, s14, matching the plan’s search',
    );
    await v.unmount();
  });

  // REV-RPF2-4: a fills-nothing piece's findings, on its own row, in full
  // when opened, rendered as the report's findings are.
  it('shows a piece’s own findings on its row when opened', async () => {
    const found = {
      seq: '000006',
      piece: {
        ...FIRST.piece,
        counts: {},
        fields: [],
        note: 'Its findings are in the report.',
        findings: '## Odd\n\n- **ka** glossed two ways.',
      },
    };
    const v = await mount(clientOf([jobOf()], [page([found])]));
    const row = rows(v.container)[0];
    expect(row.querySelector('[data-testid="piece-findings"]')).toBeNull();
    await v.step(() => byText(row, 'button', 'Show findings').click());
    const shown = row.querySelector('[data-testid="piece-findings"]');
    expect(shown.querySelector('strong').textContent).toBe('ka');
    expect(text(shown)).not.toContain('**');
    expect(byText(row, 'button', 'Hide findings')).toBeTruthy();
    await v.unmount();
  });

  // RPF3-E: the report's findings, shown first, hold the piece's whole: its
  // row offers them no second time. Where the report cut some, rows keep
  // theirs (REV-RPF2-4).
  it('offers a piece’s findings on its row only where the report does not hold them whole', async () => {
    const found = {
      seq: '000006',
      piece: { ...FIRST.piece, counts: {}, fields: [], findings: '## Odd\n\n- ka.' },
    };
    const ended = (report) =>
      jobOf({
        state: 'done',
        finishedAt: '2026-11-12T11:00:00Z',
        report: { totals: { documentsDone: 1, sentences: 0 }, documents: [], ...report },
      });
    let v = await mount(clientOf([ended({ findings: '## Odd\n\n- ka.' })], [page([found])]));
    expect(byText(rows(v.container)[0], 'button', 'Show findings')).toBeNull();
    await v.unmount();
    v = await mount(
      clientOf([ended({ findings: 'cut', findingsPieces: 80, findingsCut: 48 })], [page([found])]),
    );
    expect(byText(rows(v.container)[0], 'button', 'Show findings')).toBeTruthy();
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
    expect(rows(v.container)).toHaveLength(1);
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

  it('stops offering more at the route’s cap of 1,000 and says so', async () => {
    const client = clientOf([jobOf()], [page([SECOND, FIRST], 'c')]);
    const v = await mount(client);
    for (let i = 0; i < 39; i++) {
      await v.step(() => byText(activity(v.container), 'button', 'Show more').click());
    }
    expect(client.jobs.piecesPage).toHaveBeenLastCalledWith('j1', { limit: 1000 });
    expect(all(activity(v.container), 'button')).toHaveLength(0);
    expect(text(activity(v.container))).toContain('Only the newest 1,000 are listed.');
    await v.unmount();
  });

  it('leaves its plan out once the job has ended and the page says the plan', async () => {
    const ended = jobOf({
      state: 'done',
      finishedAt: '2026-11-12T11:00:00Z',
      report: {
        plan: { by: 'model', pieces: 'sentences', fillsNames: ['Gloss'], fallback: [] },
        totals: {},
        documents: [],
      },
    });
    const v = await mount(clientOf([ended], [page([FIRST, PLAN])]));
    expect(rows(v.container).map((li) => li.dataset.seq)).toEqual(['000001']);
    await v.unmount();
  });
});
