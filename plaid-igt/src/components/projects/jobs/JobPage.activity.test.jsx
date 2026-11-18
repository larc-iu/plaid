import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, byText, all } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';

// The job page's list of the job's work (BRIEF LV, "Work so far" on the
// Overview while it runs, the Notes section once it has ended): a row per
// piece of the job's work as its worker summed it up, newest first, read again
// with each read of the job, on the shared pager at the tall list's page. The
// plan's row is the Overview's Plan line above the list, from the moment
// planning ends (RPF-P4). And each document's Changes link while the job runs
// says it is so far.
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

const mount = (client, query = '') =>
  renderComponent(
    <MemoryRouter initialEntries={[`/projects/p1/jobs/j1${query}`]}>
      <ConfirmProvider>
        <JobPage project={PROJECT} projectId="p1" jobId="j1" client={client} />
      </ConfirmProvider>
    </MemoryRouter>,
  );

const activity = (root) =>
  root.querySelector('section[aria-label="Work so far"], section[aria-label="Notes"]');
const rows = (root) => all(activity(root), '[data-testid="job-activity"] > li');
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
// The Overview's Plan line while the job runs.
const planLine = (root) => root.querySelector('[data-testid="job-plan"]');
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
    expect(planLine(v.container)).toBeNull();
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    // RP-9: the plan, the one statement of what a job from the form fills,
    // while the job runs, above the list and not in it.
    expect(rows(v.container)).toHaveLength(0);
    expect(text(planLine(v.container))).toBe(
      'Plan Worked in stretches of sentences. Fills: Gloss.',
    );
    const plan = planLine(v.container);
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

  it('shows the newest page, reads more on the next page, and reads the plan once past the first page', async () => {
    const client = clientOf(
      [jobOf()],
      [page([SECOND, FIRST], 'c'), page([SECOND, FIRST, PLAN]), page([SECOND, FIRST, PLAN])],
    );
    const v = await mount(client);
    expect(rows(v.container)).toHaveLength(2);
    // The plan's row is the oldest: read once, at the route's cap.
    expect(client.jobs.piecesPage).toHaveBeenNthCalledWith(2, 'j1', { limit: 1000 });
    expect(text(planLine(v.container))).toBe(
      'Plan Worked in stretches of sentences. Fills: Gloss.',
    );
    // The pager says there is more than is read, and its next page reads it.
    expect(text(activity(v.container))).toContain('1–2 of 2+');
    await v.step(() =>
      activity(v.container).querySelector('button[aria-label="Next page"]').click(),
    );
    expect(client.jobs.piecesPage).toHaveBeenLastCalledWith('j1', {
      limit: 2 * TALL_LIST_PAGE_SIZE,
    });
    expect(client.jobs.piecesPage).toHaveBeenCalledTimes(3);
    expect(rows(v.container)).toHaveLength(2);
    // All of it read: one page, and no pager.
    expect(activity(v.container).querySelector('button[aria-label="Next page"]')).toBeNull();
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

  // BRIEF RW B5, REV-RW-7, REV-RW-R2-6: a piece that did not finish says how
  // it ended and, once the job has ended, what followed it among the
  // documents it sent to stretches.
  const whole = { ...FIRST.piece, first: null, last: null, firstId: null, whole: true, fields: [] };
  const ends = (root) =>
    rows(root).map((r) => all(r, '[data-testid="piece-end"]').map((p) => text(p)));
  const ended = (documents) =>
    jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z', documents });
  const doc = (id, state) => ({ ...jobOf().documents[0], documentId: id, name: id, state });

  it('says how a piece that did not finish ended and what followed it', async () => {
    const at = (seq, piece) => ({ seq, piece: { ...piece, piece: `k${seq}` } });
    const v = await mount(
      clientOf(
        [ended([doc('d1', 'done'), doc('d2', 'gone')])],
        [
          page([
            at('000010', {
              ...whole,
              counts: {},
              note: '',
              failed: 'budget',
              rest: 1,
              restDocuments: ['d1'],
            }),
            at('000011', {
              ...whole,
              counts: {},
              note: '',
              failed: 'no-answer',
              rest: 1,
              restDocuments: ['d1'],
            }),
            at('000012', { ...FIRST.piece, ended: 'budget' }),
            at('000013', { ...FIRST.piece, counts: {}, fields: [], ended: 'budget' }),
            at('000014', { ...whole, ended: 'output', rest: 1, restDocuments: ['d1'] }),
            at('000015', {
              ...whole,
              document: null,
              counts: {},
              note: '',
              failed: 'budget',
              rest: 2,
              restDocuments: ['d1', 'd2'],
            }),
            // A check whose failed piece is followed by no walk.
            at('000016', { ...whole, counts: {}, note: '', failed: 'budget' }),
          ]),
        ],
      ),
      '?view=notes',
    );
    expect(ends(v.container)).toEqual([
      ['Failed: over budget.', 'Worked again in stretches of sentences.'],
      ['No answer from the assistant.', 'Worked again in stretches of sentences.'],
      ['Steps used up: written as staged.'],
      ['Steps used up: what it had staged was not written.'],
      ['Answer too long: written as staged.', 'The rest worked in stretches of sentences.'],
      // d2 is deleted.
      ['Failed: over budget.', 'Worked again in stretches of sentences in 1 document of 2.'],
      ['Failed: over budget.'],
    ]);
    await v.unmount();
  });

  it('counts only among the documents the rest went to, and says nothing of them while the job runs', async () => {
    // The reviewer's case: rest d1 and d2, d1 in use, d3 done in the one step.
    const piece = {
      ...whole,
      document: null,
      ended: 'budget',
      rest: 2,
      restDocuments: ['d1', 'd2'],
    };
    const states = [doc('d1', 'in-use'), doc('d2', 'done'), doc('d3', 'done')];
    let v = await mount(
      clientOf([ended(states)], [page([{ seq: '000030', piece }])]),
      '?view=notes',
    );
    expect(ends(v.container)).toEqual([
      [
        'Steps used up: written as staged.',
        'The rest worked in stretches of sentences in 1 document of 2.',
      ],
    ]);
    await v.unmount();
    v = await mount(clientOf([jobOf({ documents: states })], [page([{ seq: '000030', piece }])]));
    expect(ends(v.container)).toEqual([['Steps used up: written as staged.']]);
    await v.unmount();
  });

  // REV-RW-R3-3: past the 50 documents a summary lists, no outcome is
  // claimed, only how many documents the rest went to.
  it('states no outcome past the documents the summary lists', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `d${i + 1}`);
    const states = ids.map((id, i) => doc(id, i >= 50 ? 'in-use' : 'done'));
    const at = (seq, extra) => ({
      seq,
      piece: {
        ...whole,
        piece: `k${seq}`,
        document: null,
        rest: 60,
        restDocuments: ids.slice(0, 50),
        ...extra,
      },
    });
    const v = await mount(
      clientOf(
        [ended(states)],
        [
          page([
            at('000040', { counts: {}, note: '', failed: 'budget' }),
            at('000041', { ended: 'budget' }),
          ]),
        ],
      ),
      '?view=notes',
    );
    expect(ends(v.container)).toEqual([
      ['Failed: over budget.', 'Then 60 documents went to stretches of sentences.'],
      [
        'Steps used up: written as staged.',
        'The rest went to stretches of sentences in 60 documents.',
      ],
    ]);
    await v.unmount();
  });

  it('says a document that then ended in use or deleted was not worked again', async () => {
    const v = await mount(
      clientOf(
        [ended([doc('d1', 'in-use'), doc('d2', 'gone')])],
        [
          page([
            {
              seq: '000020',
              piece: {
                ...whole,
                piece: 'k20',
                counts: {},
                note: '',
                failed: 'budget',
                rest: 1,
                restDocuments: ['d1'],
              },
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
                rest: 1,
                restDocuments: ['d2'],
              },
            },
          ]),
        ],
      ),
      '?view=notes',
    );
    expect(ends(v.container)).toEqual([
      ['Failed: over budget.', 'Not worked again: in use.'],
      ['Failed: answer too long.', 'Not worked again: deleted.'],
    ]);
    await v.unmount();
  });

  // RPF3-B: the piece after a text edit is a row of its own, named by what it
  // took.
  // D12, REV-JR2-2 (JOIN18): a piece of scattered sentences is named one by
  // one, the rest past its list counted.
  it('names a piece of scattered sentences one by one', async () => {
    const scattered = (seq, extra) => ({
      seq,
      piece: { ...FIRST.piece, piece: `k${seq}`, first: 's3', last: 's7', ...extra },
    });
    const v = await mount(
      clientOf(
        [jobOf()],
        [
          page([
            scattered('000007', { sentences: ['s3', 's5', 's7'] }),
            scattered('000008', { sentences: ['s3', 's5', 's7'], sentencesMore: 40 }),
            scattered('000009', {}),
          ]),
        ],
      ),
    );
    const where = rows(v.container).map((r) => text(r.querySelector('a')));
    expect(where).toEqual([
      'Story A s3, s5, s7',
      'Story A s3, s5, s7 and 40 more',
      'Story A s3 to s7',
    ]);
    await v.unmount();
  });

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
      'section[aria-label="Work so far"], section[aria-label="Notes"]',
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
    let v = await mount(
      clientOf([ended({ findings: '## Odd\n\n- ka.' })], [page([found])]),
      '?view=notes',
    );
    expect(byText(rows(v.container)[0], 'button', 'Show findings')).toBeNull();
    await v.unmount();
    v = await mount(
      clientOf([ended({ findings: 'cut', findingsPieces: 80, findingsCut: 48 })], [page([found])]),
      '?view=notes',
    );
    expect(byText(rows(v.container)[0], 'button', 'Show findings')).toBeTruthy();
    await v.unmount();
  });

  // S2-2: the one step's row of a plan that named some of the documents.
  it('names the one step’s row by how many documents its plan named', async () => {
    const step = {
      seq: '000001',
      piece: { ...FIRST.piece, document: null, name: null, whole: true, first: null, last: null },
    };
    const plan = {
      ...PLAN,
      piece: { ...PLAN.piece, plan: { ...PLAN.piece.plan, pieces: 'selection' } },
    };
    let v = await mount(clientOf([jobOf()], [page([step, plan])]));
    expect(text(rows(v.container)[0])).toMatch(/^All documents/);
    await v.unmount();
    const named = {
      ...PLAN,
      piece: {
        ...PLAN.piece,
        plan: { ...PLAN.piece.plan, pieces: 'selection', documentsNamed: 2 },
      },
    };
    v = await mount(clientOf([jobOf()], [page([step, named])]));
    expect(text(rows(v.container)[0])).toMatch(/^2 documents of the plan/);
    expect(text(planLine(v.container))).toContain('Worked on 2 documents in one part.');
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

  it('moves the rows to the Notes section once the job has ended', async () => {
    const ended = jobOf({
      state: 'done',
      finishedAt: '2026-11-12T11:00:00Z',
      report: { totals: { documentsDone: 1, sentences: 2 }, documents: [] },
    });
    let v = await mount(clientOf([ended], [page([FIRST, PLAN])]));
    // The Overview has the report, and a Notes section counts the rows.
    expect(activity(v.container)).toBeNull();
    expect(v.container.querySelector('section[aria-label="Report"]')).not.toBeNull();
    expect(text(byText(v.container, '[role="tab"]', 'Notes'))).toBe('Notes1');
    await v.unmount();
    v = await mount(clientOf([ended], [page([FIRST, PLAN])]), '?view=notes');
    expect(rows(v.container)).toHaveLength(1);
    expect(activity(v.container).getAttribute('aria-label')).toBe('Notes');
    await v.unmount();
  });

  it('shows nothing for an ended job whose worker kept no summary, one started from the form', async () => {
    const ended = jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z', setup: undefined });
    const v = await mount(clientOf([ended], [page([])]));
    expect(activity(v.container)).toBe(null);
    await v.unmount();
  });

  it('says a document’s Changes are so far while the job runs', async () => {
    const v = await mount(clientOf([jobOf()], [page([])]), '?view=documents');
    const link = byText(v.container, 'a', 'Changes so far');
    expect(link.getAttribute('href')).toBe('/projects/p1/documents/d1?history=g-d1');
    await v.unmount();
    const ended = jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z' });
    const w = await mount(clientOf([ended], [page([])]), '?view=documents');
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
    const short = await mount(clientOf([ended], [page([FIRST, PLAN])]), '?view=notes');
    // The document counts 4 words and 6 changes, the row 4 and 6: nothing short.
    expect(short.container.querySelector('[data-testid="job-activity-short"]')).toBe(null);
    await short.unmount();
    const more = jobOf({
      ...ended,
      documents: [{ ...ended.documents[0], counts: { words: 7, changes: 6 } }],
    });
    const v = await mount(clientOf([more], [page([FIRST, PLAN])]), '?view=notes');
    expect(text(v.container.querySelector('[data-testid="job-activity-short"]'))).toBe(
      'Some finished work is not listed here. The totals count all of it.',
    );
    await v.unmount();
    // Not while the job runs.
    const w = await mount(clientOf([jobOf({ documents: more.documents })], [page([FIRST, PLAN])]));
    expect(w.container.querySelector('[data-testid="job-activity-short"]')).toBe(null);
    await w.unmount();
  });

  it('stops offering more at the route’s cap of 1,000 and says so', async () => {
    // Page 40 of the work so far: 40 pages of 25 are the route's cap.
    const client = clientOf([jobOf()], [page([SECOND, FIRST], 'c')]);
    const v = await mount(client, '?page=40');
    expect(client.jobs.piecesPage).toHaveBeenLastCalledWith('j1', { limit: 1000 });
    expect(text(activity(v.container))).not.toContain('2+');
    expect(text(activity(v.container))).toContain('Only the newest 1,000 are listed.');
    await v.unmount();
    // Once it has ended, every row is read at the cap, and a cut says so too.
    const ended = jobOf({
      state: 'done',
      finishedAt: '2026-11-12T11:00:00Z',
      report: { totals: {}, documents: [] },
    });
    const w = await mount(clientOf([ended], [page([SECOND, FIRST], 'c')]), '?view=notes');
    expect(text(activity(w.container))).toContain('Only the newest 1,000 are listed.');
    await w.unmount();
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
    const v = await mount(clientOf([ended], [page([FIRST, PLAN])]), '?view=notes');
    expect(rows(v.container).map((li) => li.dataset.seq)).toEqual(['000001']);
    await v.unmount();
  });
});
