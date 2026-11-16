import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, byText, all } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';

// The job page: the words for each state, the queue ahead of a waiting job,
// Stop for whoever may stop it, the report once the job has ended, and a read
// every JOB_POLL_MS that stops when the job does.
const auth = vi.hoisted(() => ({ user: { id: 'w', isAdmin: false } }));
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => auth }));
const feedback = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('@/utils/feedback', () => feedback);
const { JobPage } = await import('./JobPage.jsx');
const { JOB_POLL_MS } = await import('@ui/domain/jobs.js');

const PROJECT = {
  id: 'p1',
  maintainers: ['m'],
  writers: ['w', 'w2'],
  readers: ['r'],
  vocabs: [
    { id: 'v1', name: 'Kukama lexicon' },
    { id: 'v2', name: 'Borrowed lexicon' },
    { id: 'v3', name: 'Spanish loans' },
  ],
};

const jobOf = (over = {}) => ({
  id: 'j1',
  project: 'p1',
  app: 'igt',
  instructions: 'Gloss ka as GO.',
  startedBy: 'w',
  startedByName: 'Wren',
  state: 'running',
  phase: 'working',
  reason: null,
  message: 'Sentences 11 to 15 of 40.',
  waitingFor: null,
  currentDocument: 'd1',
  model: 'glm-5.3-flash',
  createdAt: '2026-11-12T10:00:00Z',
  startedAt: '2026-11-12T10:01:00Z',
  finishedAt: null,
  ahead: null,
  documents: [
    {
      documentId: 'd1',
      name: 'Story A',
      position: 0,
      state: 'working',
      sentences: 50,
      targets: 40,
      done: 10,
      counts: { translations: 3, refreshed: 2, words: 31, links: 20, entries: 4 },
      skipped: [],
    },
    {
      documentId: 'd2',
      name: null,
      position: 1,
      state: 'gone',
      sentences: null,
      targets: null,
      done: null,
      counts: {},
      skipped: [],
    },
  ],
  report: null,
  ...over,
});

const REPORT = {
  state: 'done',
  instructions: 'Gloss ka as GO.',
  summary: 'The job glossed Story A and proposed one change.',
  summaryBy: 'model',
  summaryFailed: false,
  plan: { pieces: 'sentences', by: 'model', fallback: [{ documentId: 'd2', reason: 'too-long' }] },
  pausedForPeopleS: 720,
  pausedForModelS: 0,
  stopped: null,
  totals: {
    documentsDone: 1,
    documentsInUse: 0,
    documentsGone: 1,
    documentsNotReached: 0,
    sentences: 38,
    translations: 3,
    refreshed: 2,
    words: 120,
    links: 80,
    entries: 9,
    skippedTooLong: 1,
    skippedFailed: 1,
    skippedChanged: 0,
    skippedInterrupted: 1,
    skippedNoAnswer: 1,
    changed: 2,
    proposed: 1,
    changes: 40,
    deletions: 5,
    repeated: 3,
  },
  proposed: [
    {
      kind: 'rename_document',
      documentId: 'd1',
      document: 'Story A',
      ref: null,
      field: null,
      from: null,
      to: null,
      label: 'rename Story A to Story One',
      note: 'Named the text.',
    },
  ],
  proposedMore: 2,
  notes: [{ document: 'd1', name: 'Story A', sentences: 's1 to s5', note: 'Glossed s1 to s5.' }],
  notesMore: 0,
  tables: [
    {
      title: 'Glosses of ka',
      columns: ['gloss', 'count'],
      rows: [
        ['go', 3],
        ['come', 1],
      ],
      more: 0,
    },
  ],
  documents: [
    {
      documentId: 'd1',
      name: 'Story A',
      skipped: [
        { sentence: 's12', sentenceId: 'sen12', reason: 'too-long', kind: null },
        { sentence: 's30', sentenceId: 'sen30', reason: 'failed', kind: 'repeating' },
        { sentence: 's31', sentenceId: 'sen31', reason: 'interrupted', kind: null },
        { sentence: 's32', sentenceId: 'sen32', reason: 'no-answer', kind: null },
      ],
      counts: { skippedMore: 3 },
    },
  ],
  harmonize: {
    changed: [
      {
        form: 'ka',
        to: 'ka ‘go’',
        by: 'person',
        from: [{ analysis: 'ka ‘come’', count: 2, documents: ['d1'] }],
      },
    ],
    left: [
      {
        form: 'tsa',
        reason: 'job-differs-no-majority',
        analyses: [
          { analysis: 'tsa ‘that’', count: 2 },
          { analysis: 'ts-a ‘DEM-3’', count: 2 },
        ],
      },
    ],
    changedMore: 0,
    leftMore: 7,
  },
  entries: {
    created: [{ id: 'e1', lexicon: 'v1', form: 'ka', gloss: 'go' }],
    unlinked: [{ id: 'e2', lexicon: 'v1', form: 'ra', gloss: 'eat' }],
    createdMore: 3,
    unlinkedMore: 2,
    lexicons: ['v1', 'v3'],
  },
};

const mount = async (client, project = PROJECT) =>
  renderComponent(
    <MemoryRouter>
      <ConfirmProvider>
        <JobPage project={project} projectId="p1" jobId="j1" client={client} />
      </ConfirmProvider>
    </MemoryRouter>,
  );

const clientOf = (...answers) => {
  let i = 0;
  return {
    jobs: {
      get: vi.fn(async () => answers[Math.min(i++, answers.length - 1)]),
      cancel: vi.fn(async () => jobOf({ state: 'stopping', message: null })),
      piecesPage: vi.fn(async () => ({ entries: [], nextCursor: null })),
    },
    // No assistant online (JobPage.discuss.test.jsx has one).
    messages: { discoverServices: vi.fn(async () => []) },
  };
};

const stopButton = (root) =>
  all(root, 'button').find((b) => b.textContent.trim() === 'Stop') ?? null;
const text = (root) => root.textContent.replace(/\s+/g, ' ');
// The totals, label to value.
const totals = (root) =>
  Object.fromEntries(all(root, 'dl dt').map((dt) => [dt.textContent, dt.nextSibling.textContent]));

beforeEach(() => {
  auth.user = { id: 'w', isAdmin: false };
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe('the job page', () => {
  it('says each state in words, the phase and message while running, a failure’s reason', async () => {
    const cases = [
      [
        jobOf({ state: 'waiting', phase: null, message: null, ahead: 2 }),
        ['Waiting', '2 jobs of other projects ahead'],
      ],
      [jobOf(), ['Running', 'Working', 'Sentences 11 to 15 of 40.']],
      [jobOf({ state: 'stopping' }), ['Stopping…']],
      [jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z' }), ['Done']],
      [jobOf({ state: 'cancelled', reason: 'cancelled' }), ['Stopped']],
      [
        jobOf({ state: 'failed', reason: 'guidelines-too-long', message: null }),
        ['Failed', 'The guidelines are too long for a job.'],
      ],
      [
        jobOf({
          state: 'failed',
          reason: 'guidelines-too-long',
          message: 'The project’s guidelines are 31,204 characters. A job reads at most 24,000.',
        }),
        ['Failed', 'The project’s guidelines are 31,204 characters.'],
      ],
    ];
    for (const [job, words] of cases) {
      const v = await mount(clientOf(job));
      const status = v.container.querySelector('[role="status"]');
      for (const w of words) expect(text(status)).toContain(w);
      if (job.state !== 'running') expect(text(status)).not.toContain('Working');
      await v.unmount();
    }
    const first = await mount(clientOf(jobOf({ state: 'waiting', ahead: 0 })));
    expect(text(first.container)).not.toContain('ahead');
    await first.unmount();
  });

  it('says a waiting job waits and since when, never that it started, and what is ahead of it', async () => {
    // Core lets a project hold one active job, so every job ahead of a waiting
    // one is another project's.
    const waiting = (ahead) =>
      jobOf({ state: 'waiting', phase: null, message: null, startedAt: null, ahead });
    let v = await mount(clientOf(waiting(2)));
    let facts = totals(v.container);
    expect(facts['Waiting since']).toBeTruthy();
    expect(facts.Started).toBeUndefined();
    expect(facts.Elapsed).toBeUndefined();
    expect(text(v.container.querySelector('[role="status"]'))).toContain(
      'Waiting2 jobs of other projects ahead',
    );
    await v.unmount();
    v = await mount(clientOf(waiting(1)));
    expect(text(v.container.querySelector('[role="status"]'))).toContain(
      '1 job of another project ahead',
    );
    await v.unmount();
    // Once a worker took it: when it started, and how long it waited first.
    v = await mount(
      clientOf(jobOf({ createdAt: '2026-11-12T09:33:00Z', startedAt: '2026-11-12T10:01:00Z' })),
    );
    facts = totals(v.container);
    expect(facts['Waiting since']).toBeUndefined();
    expect(facts.Started).toBeTruthy();
    expect(facts.Waited).toBe('28 min');
    await v.unmount();
    // Taken at once: no wait to speak of.
    v = await mount(clientOf(jobOf({ startedAt: '2026-11-12T10:00:20Z' })));
    expect(totals(v.container).Waited).toBeUndefined();
    await v.unmount();
    // Stopped before any worker took it: how long it waited.
    v = await mount(
      clientOf(
        jobOf({
          state: 'cancelled',
          reason: 'cancelled',
          startedAt: null,
          finishedAt: '2026-11-12T10:40:00Z',
        }),
      ),
    );
    facts = totals(v.container);
    expect(facts.Started).toBeUndefined();
    expect(facts.Waited).toBe('40 min');
    await v.unmount();
  });

  it('offers a document’s Changes only where the job wrote something there', async () => {
    const ended = jobOf({
      state: 'done',
      finishedAt: '2026-11-12T11:00:00Z',
      documents: [
        { ...jobOf().documents[0], counts: { changes: 0 }, glossGroup: 'g-d1' },
        {
          ...jobOf().documents[0],
          documentId: 'd3',
          counts: { changes: 0 },
          glossGroup: 'g-d3',
          harmonizeGroup: 'h-d3',
        },
      ],
      report: {
        ...REPORT,
        documents: [
          {
            documentId: 'd1',
            name: 'Story A',
            counts: { changes: 0 },
            glossGroup: 'g-d1',
            skipped: [{ sentence: 's1', sentenceId: 'sen1', reason: 'no-answer', kind: null }],
          },
        ],
      },
    });
    const v = await mount(clientOf(ended));
    expect(all(v.container, 'a').map((a) => a.textContent)).not.toContain('Changes');
    expect(all(v.container, 'a').map((a) => a.textContent)).toContain('Analyses made consistent');
    const report = v.container.querySelector('section[aria-label="Report"]');
    expect(all(report, 'p > a').map((a) => a.textContent)).not.toContain('Story A');
    await v.unmount();
  });

  it('links each document to what the job changed in it, and the report’s entries to themselves', async () => {
    const ended = jobOf({
      state: 'done',
      finishedAt: '2026-11-12T11:00:00Z',
      documents: [
        {
          ...jobOf().documents[0],
          counts: { ...jobOf().documents[0].counts, changes: 31 },
          glossGroup: 'g-d1',
          harmonizeGroup: 'h-d1',
        },
        { ...jobOf().documents[1], glossGroup: 'g-d2' },
      ],
      report: {
        ...REPORT,
        documents: REPORT.documents.map((d) => ({
          ...d,
          counts: { ...d.counts, changes: 3 },
          glossGroup: 'g-d1',
        })),
      },
    });
    const v = await mount(clientOf(ended));
    const rows = all(v.container, '#job-documents tbody tr, tbody tr');
    expect(all(rows[0], 'a').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Story A', '/projects/p1/documents/d1'],
      ['Changes', '/projects/p1/documents/d1?history=g-d1'],
      ['Analyses made consistent', '/projects/p1/documents/d1?history=h-d1'],
    ]);
    // A deleted document has no History to open.
    expect(all(rows[1], 'a')).toHaveLength(0);
    const report = v.container.querySelector('section[aria-label="Report"]');
    // The skipped sentences and the blanks, each under its document's name.
    expect(all(report, 'p > a').map((a) => [a.textContent, a.getAttribute('href')])).toContainEqual(
      ['Story A', '/projects/p1/documents/d1?history=g-d1'],
    );
    expect(byText(report, 'a', 'ka ‘go’').getAttribute('href')).toBe('/vocabularies/v1?item=e1');
    await v.unmount();
  });

  it('lists the job’s facts and a row per document, a deleted one by that word', async () => {
    const v = await mount(clientOf(jobOf()));
    const t = text(v.container);
    expect(t).not.toContain('Tasks');
    expect(t).toContain('Wren');
    expect(t).toContain('glm-5.3-flash');
    expect(t).toContain('Gloss ka as GO.');
    const rows = all(v.container, 'tbody tr').map((r) => text(r));
    expect(rows[0]).toContain('Story A');
    expect(rows[0]).toContain('10 of 40');
    expect(rows[0]).toContain('5'); // translations filled and replaced
    expect(rows[1]).toContain('Deleted document');
    expect(byText(v.container, 'a', 'Story A').getAttribute('href')).toBe(
      '/projects/p1/documents/d1',
    );
    await v.unmount();
  });

  it('shows what the assistant told every piece apart from the instructions, folded when long', async () => {
    const plan = (pieceInstructions) => ({
      pieces: 'document',
      pieceInstructions,
      by: 'model',
      fallback: [],
      leftOut: [],
    });
    const short = jobOf({ state: 'done', report: { ...REPORT, plan: plan('Gloss -da as LOC.') } });
    let v = await mount(clientOf(short));
    let facts = totals(v.container);
    expect(facts.Instructions).toBe('Gloss ka as GO.');
    expect(facts['Assistant’s instructions']).toBe('Gloss -da as LOC.');
    await v.unmount();
    const told = 'Gloss -da as LOC after a noun. '.repeat(12).trim();
    v = await mount(clientOf(jobOf({ state: 'done', report: { ...REPORT, plan: plan(told) } })));
    const folded = v.container.querySelector('details');
    expect(folded).not.toBeNull();
    expect(folded.open).toBe(false);
    expect(folded.querySelector('summary').textContent).toBe('Show');
    expect(folded.textContent).toContain(told);
    // Open, it says how to close it (RP-9).
    await v.step(() => {
      folded.open = true;
      folded.dispatchEvent(new Event('toggle'));
    });
    expect(folded.querySelector('summary').textContent).toBe('Hide');
    expect(totals(v.container).Instructions).toBe('Gloss ka as GO.');
    await v.unmount();
  });

  it('says when the assistant’s instructions to the pieces were cut', async () => {
    const told = 'Mark the agent of a transitive verb A.';
    const plan = {
      pieces: 'sentences',
      pieceInstructions: told,
      instructionsCut: 5210,
      by: 'model',
      fallback: [],
      leftOut: [],
    };
    let v = await mount(clientOf(jobOf({ state: 'done', report: { ...REPORT, plan } })));
    const facts = totals(v.container);
    expect(facts['Assistant’s instructions']).toBe(
      `Cut to ${told.length} of 5,210 characters. ${told}`,
    );
    await v.unmount();
    const whole = { ...plan, instructionsCut: undefined };
    v = await mount(clientOf(jobOf({ state: 'done', report: { ...REPORT, plan: whole } })));
    expect(totals(v.container)['Assistant’s instructions']).toBe(told);
    await v.unmount();
  });

  it('says a plan in stretches took only the sentences with something empty when it did', async () => {
    const plan = {
      pieces: 'sentences',
      onlyEmpty: true,
      by: 'model',
      fallback: [],
      leftOut: [],
    };
    let v = await mount(clientOf(jobOf({ state: 'done', report: { ...REPORT, plan } })));
    expect(totals(v.container).Plan).toBe(
      'Worked in stretches of sentences, only those with something empty.',
    );
    await v.unmount();
    v = await mount(
      clientOf(
        jobOf({ state: 'done', report: { ...REPORT, plan: { ...plan, onlyEmpty: false } } }),
      ),
    );
    expect(totals(v.container).Plan).toBe('Worked in stretches of sentences.');
    await v.unmount();
  });

  it('says the job may edit the text when its plan says so', async () => {
    const plan = { pieces: 'document', by: 'model', fallback: [], leftOut: [] };
    let v = await mount(
      clientOf(jobOf({ state: 'done', report: { ...REPORT, plan: { ...plan, editsText: true } } })),
    );
    expect(totals(v.container).Plan).toBe('Worked one document at a time. Text may be edited.');
    await v.unmount();
    v = await mount(clientOf(jobOf({ state: 'done', report: { ...REPORT, plan } })));
    expect(totals(v.container).Plan).toBe('Worked one document at a time.');
    await v.unmount();
  });

  it('names what the plan fills, or says it fills nothing', async () => {
    const plan = { pieces: 'sentences', by: 'model', fallback: [], leftOut: [], editsText: true };
    let v = await mount(
      clientOf(
        jobOf({
          state: 'done',
          report: { ...REPORT, plan: { ...plan, fillsNames: ['segmentation', 'Morph Gloss'] } },
        }),
      ),
    );
    expect(totals(v.container).Plan).toBe(
      'Worked in stretches of sentences. Fills: segmentation, Morph Gloss. Text may be edited.',
    );
    await v.unmount();
    v = await mount(
      clientOf(jobOf({ state: 'done', report: { ...REPORT, plan: { ...plan, fillsNames: [] } } })),
    );
    expect(totals(v.container).Plan).toBe(
      'Worked in stretches of sentences. Fills nothing. Text may be edited.',
    );
    await v.unmount();
  });

  // A job set up in a conversation (BRIEF-SU) says, from its creation on,
  // what it was set up to fill and whether it may edit the text, and links
  // the conversation for the person who started it, whose it is.
  it('says what a job was set up to fill, and links its conversation for its starter', async () => {
    const setup = {
      fills: [
        { id: 'L1', name: 'Case' },
        { id: 'L2', name: 'Word class' },
      ],
      text: false,
      conversation: 'c9',
    };
    const line = (root) => root.querySelector('[data-testid="job-setup"]');
    let v = await mount(clientOf(jobOf({ state: 'waiting', phase: null, setup })));
    expect(line(v.container).textContent).toBe(
      'Set up to fill Case, Word class. Text unchanged. Open conversation',
    );
    const link = byText(v.container, 'a', 'Open conversation');
    expect(link.getAttribute('href')).toBe('/projects/p1?tab=assistant&conversation=c9');
    await v.unmount();

    auth.user = { id: 'w2', isAdmin: false };
    v = await mount(clientOf(jobOf({ setup: { ...setup, fills: [], text: true } })));
    expect(line(v.container).textContent).toBe('Set up to fill nothing. Text may be edited.');
    expect(byText(v.container, 'a', 'Open conversation')).toBeFalsy();
    await v.unmount();

    auth.user = { id: 'w', isAdmin: false };
    v = await mount(
      clientOf(jobOf({ setup: { fills: [{ id: 'L1', name: 'Case' }], text: false } })),
    );
    expect(line(v.container).textContent).toBe('Set up to fill Case. Text unchanged.');
    await v.unmount();

    v = await mount(clientOf(jobOf()));
    expect(line(v.container)).toBeNull();
    expect(text(v.container)).not.toContain('Set up to');
    await v.unmount();

    // R3: only the words the job adds.
    v = await mount(
      clientOf(
        jobOf({ setup: { fills: [{ id: 'L2', name: 'Word class' }], text: true, onlynew: true } }),
      ),
    );
    expect(line(v.container).textContent).toBe(
      'Set up to fill Word class, only on the words it adds. Text may be edited.',
    );
    await v.unmount();

    // A setup with no `onlynew` (every setup made before R3, and every card
    // without the row) has no such limit and reads as the worker reads it.
    // `onlynew: false` reads the same. Present and null is unreadable, as there.
    for (const onlynew of [undefined, false]) {
      const setup = { fills: [{ id: 'L2', name: 'Word class' }], text: true };
      if (onlynew !== undefined) setup.onlynew = onlynew;
      v = await mount(clientOf(jobOf({ setup })));
      expect(line(v.container).textContent).toBe('Set up to fill Word class. Text may be edited.');
      await v.unmount();
    }
    v = await mount(
      clientOf(
        jobOf({ setup: { fills: [{ id: 'L2', name: 'Word class' }], text: true, onlynew: null } }),
      ),
    );
    expect(line(v.container)).toBeNull();
    await v.unmount();
  });

  it('says when planning ended with no plan and nothing was written', async () => {
    const plan = { by: 'none', why: 'no-plan', pieceInstructions: '', fallback: [], leftOut: [] };
    const v = await mount(
      clientOf(
        jobOf({ state: 'failed', reason: 'no-plan', message: null, report: { ...REPORT, plan } }),
      ),
    );
    expect(totals(v.container).Plan).toBe('Planning ended with no plan. Nothing was written.');
    expect(text(v.container.querySelector('[role="status"]'))).toContain(
      'Planning ended with no plan.',
    );
    await v.unmount();
  });

  // REV-SU-B-3, REV-SU-F-2: a job whose setup's fields are all gone ends
  // saying so, by its plan's why, naming them as the card did, and its setup
  // line marks each the plan found gone, by id.
  it('says a job’s setup fields are gone, naming them, and marks a deleted one in its setup line', async () => {
    const setup = {
      fills: [
        { id: 'L1', name: 'Part of Speech' },
        { id: 'L2', name: 'Case' },
      ],
      text: false,
    };
    const line = (root) => root.querySelector('[data-testid="job-setup"]');
    const gone = { by: 'none', why: 'setup-gone', gone: setup.fills, fallback: [], leftOut: [] };
    let v = await mount(
      clientOf(
        jobOf({
          state: 'failed',
          reason: 'setup-gone',
          message: null,
          setup,
          report: { ...REPORT, plan: gone },
        }),
      ),
    );
    expect(totals(v.container).Plan).toBe(
      'The fields this job was set up to fill are gone: Part of Speech, Case. Nothing was written.',
    );
    expect(text(v.container.querySelector('[role="status"]'))).toContain(
      'The fields this job was set up to fill are gone.',
    );
    expect(line(v.container).textContent).toBe(
      'Set up to fill Part of Speech (deleted), Case (deleted). Text unchanged.',
    );
    await v.unmount();

    const some = { ...REPORT.plan, gone: [{ id: 'L1', name: 'Part of Speech' }] };
    v = await mount(clientOf(jobOf({ setup, report: { ...REPORT, plan: some } })));
    expect(line(v.container).textContent).toBe(
      'Set up to fill Part of Speech (deleted), Case. Text unchanged.',
    );
    await v.unmount();
  });

  // REV-SU-F-1, REV-SU-B-6: core keeps any map as a setup, so the page draws
  // the line only for the card's shape and never blanks on another. A job
  // whose setup the worker could not read ends saying so.
  it('draws no setup line for a setup that is not the card’s shape, and says when it could not be read', async () => {
    const line = (root) => root.querySelector('[data-testid="job-setup"]');
    for (const setup of [
      { fills: 'Gloss', text: 'no' },
      { fills: [{ id: 'x', name: { a: 1 } }], text: false },
      { fills: [null, 3], text: false },
      { fills: { id: 'x', name: 'Gloss' }, text: false },
      {},
      { fills: [{ id: 'x' }], text: false },
      { fills: [{ name: 'Gloss' }], text: false },
      { fills: [{ id: 'x', name: 'Gloss' }], text: 'yes' },
      { fills: [{ id: 'x', name: 'Gloss' }], text: true, onlynew: 'yes' },
    ]) {
      const v = await mount(clientOf(jobOf({ setup })));
      expect(text(v.container)).toContain('Instructions');
      expect(line(v.container)).toBeNull();
      await v.unmount();
    }
    const plan = { by: 'none', why: 'setup-unreadable', fallback: [], leftOut: [] };
    const v = await mount(
      clientOf(
        jobOf({
          state: 'failed',
          reason: 'setup-unreadable',
          message: null,
          setup: { fills: 'Gloss' },
          report: { ...REPORT, plan },
        }),
      ),
    );
    expect(totals(v.container).Plan).toBe(
      'This job’s setup could not be read. Nothing was written.',
    );
    expect(text(v.container.querySelector('[role="status"]'))).toContain(
      'This job’s setup could not be read.',
    );
    await v.unmount();
  });

  it('keeps the setup line of a job that ended with no plan, beside its Plan line', async () => {
    const plan = { by: 'none', why: 'no-plan', pieceInstructions: '', fallback: [], leftOut: [] };
    const setup = { fills: [{ id: 'L1', name: 'Case' }], text: false };
    const v = await mount(
      clientOf(
        jobOf({
          state: 'failed',
          reason: 'no-plan',
          message: null,
          setup,
          report: { ...REPORT, plan },
        }),
      ),
    );
    expect(v.container.querySelector('[data-testid="job-setup"]').textContent).toBe(
      'Set up to fill Case. Text unchanged.',
    );
    expect(totals(v.container).Plan).toBe('Planning ended with no plan. Nothing was written.');
    await v.unmount();
  });

  it('says when the model failed during planning, apart from a planning with no plan', async () => {
    const plan = { by: 'none', why: 'output', pieceInstructions: '', fallback: [], leftOut: [] };
    const v = await mount(
      clientOf(
        jobOf({
          state: 'failed',
          reason: 'planning-failed',
          message: null,
          report: { ...REPORT, plan },
        }),
      ),
    );
    expect(totals(v.container).Plan).toBe(
      'The assistant’s model failed during planning. Nothing was written.',
    );
    const status = text(v.container.querySelector('[role="status"]'));
    expect(status).toContain('The assistant’s model failed during planning. Start the job again.');
    expect(status).not.toContain('Planning ended with no plan.');
    await v.unmount();
  });

  it('shows the totals first and the assistant’s summary after them, under its heading', async () => {
    const v = await mount(clientOf(jobOf({ state: 'done', report: REPORT })));
    const report = v.container.querySelector('section[aria-label="Report"]');
    const headings = all(report, 'h3').map((h) => h.textContent);
    expect(headings.indexOf('Totals')).toBe(0);
    expect(headings.indexOf('Assistant’s summary')).toBe(1);
    const summary = report.querySelector('[data-testid="job-summary"]');
    expect(summary.previousElementSibling.previousElementSibling.textContent).toBe(
      'Assistant’s summary',
    );
    expect(text(summary).trim()).toBe('The job glossed Story A and proposed one change.');
    await v.unmount();
  });

  it('keeps the assistant’s summary of a job that only made a table, after the totals', async () => {
    const report = {
      ...REPORT,
      summary: 'Ka is glossed go three times and come once.',
      summaryBy: 'model',
      totals: { ...REPORT.totals, changes: 0, proposed: 0, words: 0, links: 0, entries: 0 },
      proposed: [],
      proposedMore: 0,
      harmonize: { changed: [], left: [], changedMore: 0, leftMore: 0 },
    };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    const section = v.container.querySelector('section[aria-label="Report"]');
    const headings = all(section, 'h3').map((h) => h.textContent);
    expect(headings.slice(0, 2)).toEqual(['Totals', 'Assistant’s summary']);
    expect(headings).toContain('Tables');
    const summary = section.querySelector('[data-testid="job-summary"]');
    expect(summary.previousElementSibling.previousElementSibling.textContent).toBe(
      'Assistant’s summary',
    );
    expect(text(summary).trim()).toBe('Ka is glossed go three times and come once.');
    await v.unmount();
  });

  it('puts the line of a job that wrote and proposed nothing first, as the report’s own', async () => {
    const line = 'The job wrote no change and proposed none.';
    const report = { ...REPORT, summary: line, summaryBy: 'worker' };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    const section = v.container.querySelector('section[aria-label="Report"]');
    const summary = section.querySelector('[data-testid="job-summary"]');
    expect(text(summary)).toBe(line);
    expect(summary.previousElementSibling.textContent).toBe('Report');
    expect(all(section, 'h3').map((h) => h.textContent)).not.toContain('Assistant’s summary');
    await v.unmount();
  });

  it('lists each document the plan left out, in the report and in the documents table', async () => {
    const report = {
      ...REPORT,
      plan: {
        pieces: 'sentences',
        pieceInstructions: '',
        by: 'model',
        fallback: [],
        leftOut: [{ documentId: 'd2', name: null }],
        leftOutMore: 3,
      },
    };
    const job = jobOf({
      state: 'done',
      report,
      documents: [
        { ...jobOf().documents[0], state: 'done' },
        { ...jobOf().documents[1], state: 'not-reached' },
      ],
    });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    expect(all(section, 'h3').map((h) => h.textContent)).toContain('Left out by the plan');
    // A report too large for core lists the first and counts the rest.
    expect(text(section)).toContain('And 3 more documents.');
    const rows = all(v.container, '#job-documents tbody tr, tbody tr').map((r) => text(r));
    expect(rows[1]).toContain('Left out by the plan');
    await v.unmount();
  });

  it('offers Stop to the starter, a maintainer and an admin, never to another writer or a reader', async () => {
    const who = [
      [{ id: 'w', isAdmin: false }, true],
      [{ id: 'm', isAdmin: false }, true],
      [{ id: 'a', isAdmin: true }, true],
      [{ id: 'w2', isAdmin: false }, false],
      [{ id: 'r', isAdmin: false }, false],
    ];
    for (const [user, shown] of who) {
      auth.user = user;
      const v = await mount(clientOf(jobOf()));
      expect(!!stopButton(v.container)).toBe(shown);
      await v.unmount();
    }
    // A starter who no longer writes the project cannot stop it.
    auth.user = { id: 'w', isAdmin: false };
    const demoted = await mount(clientOf(jobOf()), { ...PROJECT, writers: [], readers: ['w'] });
    expect(stopButton(demoted.container)).toBe(null);
    await demoted.unmount();
    // Nor is there anything to stop once it is stopping or has ended.
    for (const state of ['stopping', 'done', 'cancelled', 'failed']) {
      const v = await mount(clientOf(jobOf({ state })));
      expect(stopButton(v.container)).toBe(null);
      await v.unmount();
    }
  });

  it('asks before it stops the job, and shows what the cancel answers', async () => {
    const client = clientOf(jobOf());
    const v = await mount(client);
    await v.step(() => stopButton(v.container).click());
    expect(text(document.body)).toContain('Stop the job?');
    expect(text(document.body)).toContain('What it wrote stays.');
    expect(client.jobs.cancel).not.toHaveBeenCalled();
    const confirmStop = all(document.body, '[role="alertdialog"] button').find(
      (b) => b.textContent.trim() === 'Stop',
    );
    await v.step(() => confirmStop.click());
    await v.step(async () => {});
    expect(client.jobs.cancel).toHaveBeenCalledWith('j1');
    expect(text(v.container.querySelector('[role="status"]'))).toContain('Stopping…');
    // Asked once: nothing offers it again while the job stops (REV-J-C-4).
    expect(stopButton(v.container)).toBe(null);
    await v.unmount();
  });

  it('reads the job again while it is active, and stops reading once it has ended', async () => {
    vi.useFakeTimers();
    const client = clientOf(
      jobOf(),
      jobOf({ message: 'Sentences 16 to 20 of 40.' }),
      jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z', report: REPORT }),
    );
    const v = await mount(client);
    expect(client.jobs.get).toHaveBeenCalledTimes(1);
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    expect(client.jobs.get).toHaveBeenCalledTimes(2);
    expect(text(v.container)).toContain('Sentences 16 to 20 of 40.');
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    expect(client.jobs.get).toHaveBeenCalledTimes(3);
    expect(text(v.container)).toContain('Report');
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 4));
    expect(client.jobs.get).toHaveBeenCalledTimes(3);
    await v.unmount();
  });

  // A worker that went silent (REV-J-C-3): core says so on every read
  // (`lapsed`), and a Stop ends the job at once, a stopping one included.
  it('says when a running job’s worker last reported, and offers Stop', async () => {
    const v = await mount(clientOf(jobOf({ lapsed: true, heartbeatAt: '2026-11-12T14:05:00Z' })));
    expect(text(v.container.querySelector('[role="status"]'))).toContain(
      'No worker has reported since ',
    );
    expect(stopButton(v.container)).not.toBe(null);
    await v.unmount();
  });

  it('offers Stop again on a stopping job whose worker went silent, and shows it stopped', async () => {
    const client = clientOf(
      jobOf({ state: 'stopping', lapsed: true, heartbeatAt: '2026-11-12T14:05:00Z' }),
    );
    client.jobs.cancel.mockResolvedValue(
      jobOf({
        state: 'cancelled',
        reason: 'cancelled',
        message: null,
        lapsed: false,
        finishedAt: '2026-11-12T14:10:00Z',
        report: { ...REPORT, state: 'cancelled', stopped: 'without-worker' },
      }),
    );
    const v = await mount(client);
    const status = () => text(v.container.querySelector('[role="status"]'));
    expect(status()).toContain('Stopping…');
    expect(status()).toContain('No worker has reported since ');
    await v.step(() => stopButton(v.container).click());
    const confirmStop = all(document.body, '[role="alertdialog"] button').find(
      (b) => b.textContent.trim() === 'Stop',
    );
    await v.step(() => confirmStop.click());
    await v.step(async () => {});
    expect(client.jobs.cancel).toHaveBeenCalledWith('j1');
    expect(status()).toContain('Stopped');
    expect(status()).not.toContain('No worker has reported');
    expect(stopButton(v.container)).toBe(null);
    await v.unmount();
  });

  it('reads a finished job once', async () => {
    vi.useFakeTimers();
    const client = clientOf(jobOf({ state: 'cancelled', finishedAt: '2026-11-12T11:00:00Z' }));
    const v = await mount(client);
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 3));
    expect(client.jobs.get).toHaveBeenCalledTimes(1);
    await v.unmount();
  });

  it('shows the report: totals, skipped sentences, harmonize, entries and their cuts', async () => {
    const job = jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z', report: REPORT });
    const v = await mount(clientOf(job));
    const report = v.container.querySelector('section[aria-label="Report"]');
    const t = text(report);
    for (const heading of [
      'Totals',
      'Skipped sentences',
      'Analyses made consistent',
      'Forms left inconsistent',
      'Proposed changes',
      'Notes',
      'Tables',
      'Entries',
    ]) {
      expect(all(report, 'h3').map((h) => h.textContent)).toContain(heading);
    }
    const sums = totals(report);
    expect(sums['Documents deleted']).toBe('1');
    expect(sums).not.toHaveProperty('Documents in use');
    expect(sums['Words analyzed']).toBe('120');
    expect(sums['Sentences skipped as too long']).toBe('1');
    expect(sums['Sentences skipped after an interrupted write']).toBe('1');
    expect(sums['Sentences skipped with no answer from the assistant']).toBe('1');
    expect(sums['Changes not written, changed during the job']).toBe('2');
    expect(sums['Changes written']).toBe('40');
    expect(sums['Deletions']).toBe('5');
    expect(sums['Changes left out, sentence written before an interruption']).toBe('3');
    expect(sums['Translations written']).toBe('3');
    expect(sums['Translations replaced']).toBe('2');
    expect(sums['Paused for people']).toBe('12 min');
    expect(sums).not.toHaveProperty('Waiting for the model');
    // A skipped sentence links to it on the grid, with why it was skipped.
    const s12 = byText(report, 'a', 's12');
    expect(s12.getAttribute('href')).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=sen12',
    );
    expect(t).toContain('s12 Too long');
    expect(t).toContain('s30 Failed: model repeated itself');
    expect(t).toContain('s31 Write interrupted');
    expect(t).toContain('s32 No answer from the assistant');
    expect(t).toContain('And 3 more skipped.');
    // Harmonize.
    expect(t).toContain('ka ‘go’');
    expect(t).toContain('A person’s analysis');
    expect(t).toContain('ka ‘come’ ×2');
    expect(t).toContain('The job’s analyses differ, none by two thirds');
    expect(t).toContain('And 7 more forms.');
    // Entries, each list with its own cut, and the lexicon's machine drafts.
    expect(t).toContain('ka ‘go’');
    expect(t).toContain('And 3 more entries.');
    // The job's entries nothing links, a section of their own, each linked
    // to the entry: the job deletes none (REV-JG2-1).
    expect(all(report, 'h3').map((h) => h.textContent)).toContain('Entries with no links');
    expect(byText(report, 'a', 'ra ‘eat’').getAttribute('href')).toBe('/vocabularies/v1?item=e2');
    expect(t).toContain('And 2 more entries.');
    expect(t).not.toContain('Deleted');
    // The prose the assistant wrote, after the totals.
    expect(text(report.querySelector('[data-testid="job-summary"]')).trim()).toBe(
      'The job glossed Story A and proposed one change.',
    );
    // What the job proposed and did not apply: project setup, where, and what.
    const table = byText(report, 'table', 'From').closest('table');
    expect(text(table)).toContain('rename Story A to Story One');
    expect(table.querySelector('a').textContent).toBe('Story A');
    expect(table.querySelector('a').getAttribute('href')).toBe('/projects/p1/documents/d1');
    expect(t).toContain('And 2 more changes.');
    expect(sums['Changes proposed']).toBe('1');
    // Each piece's note, and a table the job's code made, as data.
    expect(t).toContain('Story A s1 to s5: Glossed s1 to s5.');
    expect(t).toContain('Glosses of ka');
    expect(t).toContain('come1');
    expect(byText(report, 'a', 'Machine drafts in Kukama lexicon').getAttribute('href')).toBe(
      '/vocabularies/v1?status=machine',
    );
    // Only a lexicon the job created entries in, one past the list's cut too.
    expect(byText(report, 'a', 'Machine drafts in Spanish loans').getAttribute('href')).toBe(
      '/vocabularies/v3?status=machine',
    );
    expect(t).not.toContain('Borrowed lexicon');
    await v.unmount();
  });

  it('lists the targets the job left blank, each linked into the grid, with what is blank there', async () => {
    const report = {
      ...REPORT,
      documents: [
        {
          documentId: 'd1',
          name: 'Story A',
          skipped: [],
          left: [
            { ref: 's3', sentenceId: 'sen3', begin: null, form: null, targets: ['Note'] },
            {
              ref: 's3.w2',
              sentenceId: 'sen3',
              begin: 14,
              form: 'kata',
              targets: ['segmentation', 'Morph Gloss'],
            },
          ],
          leftMore: 4,
        },
        {
          documentId: 'd2',
          name: null,
          skipped: [],
          left: [{ ref: 's1.w1', sentenceId: 'sen1', begin: 0, form: 'ra', targets: ['Role'] }],
          leftMore: 0,
        },
        { documentId: 'd3', name: 'Story C', skipped: [], left: [], leftMore: 0 },
      ],
    };
    const job = jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z', report });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    expect(all(section, 'h3').map((h) => h.textContent)).toContain('Left blank');
    const t = text(section);
    // A sentence field by its name (never "Translation" for any of them), a
    // word by its form and the targets it is blank for.
    expect(t).toContain('s3 Note');
    expect(t).toContain('s3.w2 kata segmentation, Morph Gloss');
    expect(t).toContain('And 4 more left blank.');
    expect(byText(section, 'a', 's3.w2').getAttribute('href')).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=sen3&focusWord=14',
    );
    expect(byText(section, 'a', 's3').getAttribute('href')).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=sen3',
    );
    // A deleted document's are named and not linked, and one with none is not listed.
    expect(t).toContain('Deleted document');
    expect(t).toContain('s1.w1 ra Role');
    expect(all(section, 'a').find((a) => a.textContent === 's1.w1')).toBeUndefined();
    expect(t).not.toContain('Story C');
    await v.unmount();
  });

  it('says where a document could not be read for its blanks, and counts the sentences not reached', async () => {
    const blank = (target, unit, left, notReached) => ({ target, unit, left, notReached });
    const report = {
      ...REPORT,
      documents: [
        {
          documentId: 'd1',
          name: 'Story A',
          skipped: [],
          counts: { words: 4 },
          leftUnread: true,
        },
        {
          documentId: 'd2',
          name: 'Story B',
          skipped: [],
          counts: {
            words: 2,
            left: 1,
            notReached: 12,
            blank: [blank('segmentation', 'word', 1, 12), blank('Translation', 'sentence', 0, 1)],
          },
          left: [
            { ref: 's1.w3', sentenceId: 'sen1', begin: 9, form: 'kata', targets: ['segmentation'] },
          ],
          leftMore: 0,
        },
        {
          documentId: 'd3',
          name: 'Story C',
          skipped: [],
          counts: {
            notReached: 1,
            blank: [blank('segmentation', 'word', 0, 1), blank('Translation', 'sentence', 0, 0)],
          },
          left: [],
          leftMore: 0,
        },
        {
          documentId: 'd4',
          name: 'Story D',
          skipped: [],
          counts: {
            words: 3,
            blank: [blank('segmentation', 'word', 0, 0), blank('Translation', 'sentence', 0, 0)],
          },
          left: [],
        },
      ],
    };
    const job = jobOf({ state: 'cancelled', finishedAt: '2026-11-12T11:00:00Z', report });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    expect(all(section, 'h3').map((h) => h.textContent)).toContain('Left blank');
    const t = text(section);
    expect(t).toContain('Story ACould not be read.');
    expect(t).toContain('s1.w3 kata segmentation');
    expect(t).toContain(
      'Blank in sentences not reached: segmentation 12 words, Translation 1 sentence.',
    );
    expect(t).toContain('Story CBlank in sentences not reached: segmentation 1 word.');
    expect(t).not.toContain('Story D');
    // The totals sum the documents' rows, per target, a row each even at
    // nothing left, so they add up on screen.
    const sums = totals(section);
    expect(sums['segmentation left blank']).toBe('1 word');
    expect(sums['segmentation blank in sentences not reached']).toBe('13 words');
    expect(sums['Translation left blank']).toBe('0 sentences');
    expect(sums['Translation blank in sentences not reached']).toBe('1 sentence');
    await v.unmount();
  });

  it('counts a morpheme field in morphemes and says each document’s Left blank in its units', async () => {
    const blank = [
      { target: 'segmentation', unit: 'word', left: 4, notReached: 0, skipped: 0 },
      { target: 'Morph POS', unit: 'morpheme', left: 6, notReached: 0, skipped: 0 },
    ];
    const report = {
      ...REPORT,
      totals: { ...REPORT.totals, fields: [{ field: 'Morph POS', id: 'L5', values: 6 }], blank },
      documents: [
        {
          documentId: 'd1',
          name: 'Story A',
          state: 'done',
          done: 4,
          skipped: [],
          counts: {
            blank,
            leftUnits: [
              { unit: 'word', left: 4 },
              { unit: 'morpheme', left: 2 },
              { unit: 'sentence', left: 1 },
            ],
          },
          left: [
            { ref: 's1.w2.m2', sentenceId: 'sen1', begin: 3, form: 'ta', targets: ['Morph POS'] },
          ],
          leftMore: 6,
        },
      ],
    };
    const v = await mount(
      clientOf(
        jobOf({
          state: 'done',
          documents: [{ ...jobOf().documents[0], state: 'done', done: 4, targets: 4 }],
          report,
        }),
      ),
    );
    const section = v.container.querySelector('section[aria-label="Report"]');
    const sums = totals(section);
    expect(sums['Morph POS']).toBe('6 values');
    expect(sums['Morph POS left blank']).toBe('6 morphemes');
    expect(sums['segmentation left blank']).toBe('4 words');
    expect(text(section)).toContain('s1.w2.m2 ta Morph POS');
    const row = v.container.querySelector('table tbody tr');
    expect(text(row)).toContain('4 words, 2 morphemes, 1 sentence');
    await v.unmount();
  });

  it('counts what is blank in the skipped sentences apart', async () => {
    const blank = { target: 'Role', unit: 'word', left: 0, notReached: 0, skipped: 4 };
    const report = {
      ...REPORT,
      totals: { ...REPORT.totals, skippedNoAnswer: 2, blank: [blank] },
      documents: [
        {
          documentId: 'd1',
          name: 'Story A',
          skipped: [
            { sentence: 's1', sentenceId: 'sen1', reason: 'no-answer', kind: null },
            { sentence: 's2', sentenceId: 'sen2', reason: 'no-answer', kind: null },
          ],
          counts: { left: 0, blank: [blank] },
          left: [],
          leftMore: 0,
        },
      ],
    };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    const section = v.container.querySelector('section[aria-label="Report"]');
    expect(totals(section)['Role left blank']).toBe('0 words');
    expect(totals(section)['Role blank in skipped sentences']).toBe('4 words');
    expect(text(section)).toContain('Story ABlank in skipped sentences: Role 4 words.');
    await v.unmount();
  });

  it('takes what is left blank from the totals when they hold it, and says it beside each document', async () => {
    const report = {
      ...REPORT,
      totals: {
        ...REPORT.totals,
        blank: [{ target: 'Role', unit: 'word', left: 7, notReached: 0 }],
      },
      documents: [
        {
          documentId: 'd1',
          name: 'Story A',
          skipped: [],
          counts: {
            left: 7,
            leftUnits: [{ unit: 'word', left: 7 }],
            blank: [{ target: 'Role', unit: 'word', left: 7, notReached: 0 }],
          },
          left: [{ ref: 's1.w1', sentenceId: 'sen1', begin: 0, form: 'ka', targets: ['Role'] }],
          leftMore: 6,
        },
      ],
    };
    const job = jobOf({
      state: 'done',
      finishedAt: '2026-11-12T11:00:00Z',
      documents: [{ ...jobOf().documents[0], state: 'done', done: 40, targets: 40 }],
      report,
    });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    expect(totals(section)['Role left blank']).toBe('7 words');
    expect(totals(section)).not.toHaveProperty('Role blank in sentences not reached');
    // The documents table: "40 of 40" with how many places are left blank.
    const row = v.container.querySelector('[data-testid="job-documents"] tbody tr, table tbody tr');
    expect(text(row)).toContain('40 of 40');
    expect(text(row)).toContain('7 words');
    const headers = all(v.container, 'th').map((h) => h.textContent);
    expect(headers).toContain('Left blank');
    await v.unmount();
  });

  it('leaves Left blank empty where nothing was counted', async () => {
    const blank = (left, notReached) => [
      { target: 'Role', unit: 'word', left, notReached, skipped: 0 },
    ];
    const row = (documentId, name, state, done) => ({
      documentId,
      name,
      position: 0,
      state,
      sentences: 4,
      targets: 4,
      done,
      counts: {},
      skipped: [],
    });
    const report = {
      ...REPORT,
      documents: [
        {
          documentId: 'd1',
          name: 'Done',
          state: 'done',
          done: 4,
          counts: { blank: blank(2, 0), leftUnits: [{ unit: 'word', left: 2 }] },
          skipped: [],
          left: [{ ref: 's1.w1', sentenceId: 'sen1', begin: 0, form: 'ka', targets: ['Role'] }],
          leftMore: 1,
        },
        {
          documentId: 'd2',
          name: 'Never',
          state: 'not-reached',
          done: 0,
          counts: { blank: blank(0, 6) },
          skipped: [],
          left: [],
          leftMore: 0,
        },
        { documentId: 'd3', name: null, state: 'gone', done: null, counts: {}, skipped: [] },
        {
          documentId: 'd4',
          name: 'Partway',
          state: 'not-reached',
          done: 2,
          counts: { blank: blank(0, 3) },
          skipped: [],
          left: [],
          leftMore: 0,
        },
      ],
    };
    const job = jobOf({
      state: 'cancelled',
      finishedAt: '2026-11-12T11:00:00Z',
      documents: [
        row('d1', 'Done', 'done', 4),
        row('d2', 'Never', 'not-reached', 0),
        row('d3', null, 'gone', null),
        row('d4', 'Partway', 'not-reached', 2),
      ],
      report,
    });
    const v = await mount(clientOf(job));
    const headers = all(v.container, 'th').map((h) => h.textContent);
    const at = headers.indexOf('Left blank');
    expect(at).toBeGreaterThan(-1);
    const cells = all(v.container, 'tbody tr').map((tr) => all(tr, 'td')[at]?.textContent);
    expect(cells.slice(0, 4)).toEqual(['2 words', '', '', '0']);
    await v.unmount();
    // A job that fills nothing has no Left blank column at all.
    const none = {
      ...report,
      documents: report.documents.map((d) => ({ ...d, counts: {}, left: undefined })),
    };
    const w = await mount(clientOf(jobOf({ ...job, report: none })));
    expect(all(w.container, 'th').map((h) => h.textContent)).not.toContain('Left blank');
    await w.unmount();
  });

  it('says how many values people wrote and how much of the text the job changed, beside each document’s History', async () => {
    const report = {
      ...REPORT,
      totals: { ...REPORT.totals, peoplesValuesChanged: 3, textChanges: 1 },
    };
    const job = jobOf({
      state: 'done',
      finishedAt: '2026-11-12T11:00:00Z',
      documents: [
        {
          ...jobOf().documents[0],
          state: 'done',
          glossGroup: 'g1',
          counts: { changes: 9, peoplesValuesChanged: 3, textChanges: 1 },
        },
      ],
      report,
    });
    const v = await mount(clientOf(job));
    const sums = totals(v.container.querySelector('section[aria-label="Report"]'));
    expect(sums['People’s values, morphemes and links changed or removed']).toBe('3');
    expect(sums['Changes to the text']).toBe('1');
    const headers = all(v.container, 'th').map((h) => h.textContent);
    expect(headers).toContain('People’s values, morphemes and links changed or removed');
    expect(headers).toContain('Changes to the text');
    expect(headers).toContain('History');
    await v.unmount();
  });

  it('lists under Left blank what a refusal the job could not follow left, each sentence linked', async () => {
    const report = {
      ...REPORT,
      documents: [
        {
          documentId: 'd1',
          name: 'Story A',
          skipped: [],
          left: [],
          leftMore: 0,
          refused: [
            {
              sentence: 's1',
              sentenceId: 'sen1',
              what: 's1.w2: s1 is retyped in this plan, so its words cannot be analysed',
              code: 'text',
            },
            {
              sentence: 's2',
              sentenceId: 'sen2',
              what: 'That entry is new in this plan',
              code: 'entry-new',
            },
            {
              sentence: 's3',
              sentenceId: 'sen3',
              what: 's3.w1 is part of ...',
              code: 'expression',
            },
            { sentence: 's4', sentenceId: null, what: 'something else', code: null },
            {
              sentence: 's5',
              sentenceId: 'sen5',
              what: 's5.w1 has an analysis change',
              code: 'shape',
            },
            { sentence: 's6', sentenceId: 'sen6', what: 'vi-gam is deleted', code: 'entry-gone' },
            { sentence: null, sentenceId: null, what: 's1.w2 is already split', code: 'text' },
          ],
          refusedMore: 2,
        },
      ],
    };
    const job = jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z', report });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    expect(all(section, 'h3').map((h) => h.textContent)).toContain('Left blank');
    const t = text(section);
    expect(t).toContain('Not done, refused:');
    // A fixed label per kind of refusal, naming the change not made, never
    // the model's text (REV-DF-S-4, REV-DF3-5).
    const items = all(section, 'li').map((li) => text(li).trim());
    expect(items).toEqual(
      expect.arrayContaining([
        's1 Change to words the job retyped, split, merged or deleted',
        's2 Change that uses an entry the job made',
        's3 Link inside a multi-word expression the job made',
        's4 Refused',
        's5 Retype, split, merge or delete of words the job also changed',
        's6 Change that uses an entry the job deleted or merged',
        // The shape guard's refusal, with no sentence (D-14), is labelled too.
        'Change to words the job retyped, split, merged or deleted',
      ]),
    );
    expect(t).not.toContain('retyped in this plan');
    expect(t).not.toContain('new in this plan');
    expect(t).toContain('And 2 more refused.');
    expect(byText(section, 'a', 's1').getAttribute('href')).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=sen1',
    );
    await v.unmount();
  });

  it('says a document the job did not finish stopped partway once it finished a sentence', async () => {
    const report = {
      ...REPORT,
      totals: { ...REPORT.totals, documentsDone: 0, documentsGone: 0, documentsNotReached: 2 },
      documents: [
        {
          documentId: 'd1',
          name: 'Story A',
          state: 'not-reached',
          done: 6,
          targets: 8,
          skipped: [],
        },
        {
          documentId: 'd2',
          name: 'Story B',
          state: 'not-reached',
          done: 0,
          targets: 3,
          skipped: [],
        },
      ],
    };
    const job = jobOf({
      state: 'cancelled',
      finishedAt: '2026-11-12T11:00:00Z',
      documents: [
        { ...jobOf().documents[0], state: 'not-reached', done: 6, targets: 8 },
        {
          ...jobOf().documents[0],
          documentId: 'd2',
          name: 'Story B',
          state: 'not-reached',
          done: 0,
          targets: 3,
        },
      ],
      report,
    });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    const sums = totals(section);
    expect(sums['Documents stopped partway']).toBe('1');
    expect(sums['Documents not reached']).toBe('1');
    const rows = all(v.container, 'tbody tr').map((r) => text(r));
    expect(rows.find((r) => r.includes('Story A'))).toContain('Stopped partway');
    expect(rows.find((r) => r.includes('Story B'))).toContain('Not reached');
    await v.unmount();
  });

  // REV-RPF-P-9: a document all of whose sentences were skipped read "Done"
  // and "2 of 2". Nothing in it was worked.
  it('says a document all of whose sentences were skipped was skipped, not done', async () => {
    const skipped = ['s1', 's2'].map((s, i) => ({
      sentence: s,
      sentenceId: `sen${i}`,
      reason: 'no-answer',
    }));
    const job = jobOf({
      state: 'done',
      documents: [
        { ...jobOf().documents[0], state: 'done', done: 2, targets: 2, skipped },
        {
          ...jobOf().documents[0],
          documentId: 'd2',
          name: 'Story B',
          state: 'done',
          done: 3,
          targets: 3,
          skipped: skipped.slice(0, 1),
        },
      ],
    });
    const v = await mount(clientOf(job));
    const rows = all(v.container, 'tbody tr').map((r) => [...r.querySelectorAll('td')].map(text));
    const a = rows.find((r) => r[0] === 'Story A');
    expect(a.slice(1, 3)).toEqual(['Skipped', '0 of 2, 2 skipped']);
    const b = rows.find((r) => r[0] === 'Story B');
    expect(b.slice(1, 3)).toEqual(['Done', '2 of 3, 1 skipped']);
    await v.unmount();
    // REV-RPF2-8: the totals count it as the table says it, skipped, not done.
    const ended = jobOf({
      state: 'done',
      documents: job.documents,
      report: {
        ...REPORT,
        totals: { ...REPORT.totals, documentsDone: 2, documentsGone: 0 },
        documents: job.documents,
      },
    });
    const w = await mount(clientOf(ended));
    const sums = totals(w.container.querySelector('section[aria-label="Report"]'));
    expect(sums['Documents done']).toBe('1');
    expect(sums['Documents skipped']).toBe('1');
    await w.unmount();
  });

  // RPF3-A: a document a selection's piece changed and did not read through
  // ends with no walk. Its row says it was not read through, beside what the
  // piece changed there, and the totals count it apart from the done ones.
  it('says a document ended after the step over all documents was not read through', async () => {
    const docs = [
      {
        ...jobOf().documents[0],
        state: 'done',
        done: 20,
        targets: 20,
        counts: { changes: 1, notWalked: true },
      },
      {
        ...jobOf().documents[0],
        documentId: 'd2',
        name: 'Story B',
        state: 'done',
        done: 3,
        targets: 3,
        counts: { changes: 0 },
      },
    ];
    const job = jobOf({
      state: 'done',
      documents: docs,
      report: {
        ...REPORT,
        totals: { ...REPORT.totals, documentsDone: 2, documentsGone: 0 },
        documents: docs,
      },
    });
    const v = await mount(clientOf(job));
    const rows = all(v.container, 'tbody tr').map((r) => [...r.querySelectorAll('td')].map(text));
    expect(rows.find((r) => r[0] === 'Story A').slice(1, 3)).toEqual(['Done', 'Not read through']);
    expect(rows.find((r) => r[0] === 'Story B').slice(1, 3)).toEqual(['Done', '3 of 3']);
    const sums = totals(v.container.querySelector('section[aria-label="Report"]'));
    expect(sums['Documents done']).toBe('1');
    expect(sums['Documents not read through']).toBe('1');
    await v.unmount();
  });

  // RPF3-B (RP2-2): "Gloss left blank 0 morphemes" beside a word listed blank
  // for Gloss. The word not segmented is said beside the morphemes. A word
  // the job respelled and left its analysis on is listed for a person.
  it('says a word not segmented beside a morpheme field and lists the respelled words', async () => {
    const report = {
      ...REPORT,
      totals: {
        ...REPORT.totals,
        blank: [
          { target: 'segmentation', unit: 'word', left: 1 },
          { target: 'Gloss', unit: 'morpheme', left: 0, unsegmented: 1 },
        ],
      },
      respelled: [
        {
          documentId: 'd1',
          name: 'Story A',
          sentenceId: 'sen2',
          sentence: 's2',
          ref: 's2.w3',
          form: 'kIvalaxar',
          old: 'kvalaxar',
          morphemes: ['kvalax', 'ar'],
        },
      ],
    };
    const job = jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z', report });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    const sums = totals(section);
    expect(sums['segmentation left blank']).toBe('1 word');
    expect(sums['Gloss left blank']).toBe('0 morphemes and 1 word not segmented');
    const headings = all(section, 'h3').map((h) => h.textContent);
    expect(headings).toContain('Respelled, analysis kept: check its morphemes');
    expect(text(section)).toContain('Story A s2.w3 kIvalaxar was kvalaxar, morphemes kvalax ar');
    await v.unmount();
  });

  it('counts the tables and notes a report too large for core could not hold', async () => {
    const report = { ...REPORT, tables: [], tablesMore: 3, notes: [], notesMore: 2 };
    const job = jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z', report });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    const headings = all(section, 'h3').map((h) => h.textContent);
    expect(headings).toContain('Tables');
    expect(headings).toContain('Notes');
    const t = text(section);
    expect(t).toContain('And 3 more tables.');
    expect(t).toContain('And 2 more notes.');
    await v.unmount();
  });

  it('draws no Left blank section for a job that left nothing', async () => {
    const job = jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z', report: REPORT });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    expect(all(section, 'h3').map((h) => h.textContent)).not.toContain('Left blank');
    await v.unmount();
  });

  // RP-1, RP-3, RP-8, RP-9: "Changed since the job wrote it" stood beside
  // forms nobody changed. Each code the worker writes is a closed set (A1),
  // each worded by what is true of it.
  it('words every reason a form is left inconsistent', async () => {
    const reasons = {
      'job-differs-people-differ': 'The job’s analyses differ, and so do people’s',
      'job-differs-no-majority': 'The job’s analyses differ, none by two thirds',
      changed: 'Changed after the job wrote it',
      // A word the job was to rewrite, found verified by a person under the
      // lock (the worker review's W-9).
      verified: 'A person verified it after the job wrote it',
      'beside-others': 'Also holds work that is not the job’s',
      unvouched: 'Not checked',
      commented: 'Has a comment',
      'in-mwe': 'In a multi-word expression',
      'in-use': 'Document in use',
      refused: 'Could not be written',
    };
    const left = Object.keys(reasons).map((reason) => ({
      form: 'ka',
      reason,
      analyses: [{ analysis: 'ka ‘go’', count: 1 }],
    }));
    const report = { ...REPORT, harmonize: { ...REPORT.harmonize, left, leftMore: 0 } };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    const section = v.container.querySelector('section[aria-label="Report"]');
    const table = byText(section, 'th', 'Reason').closest('table');
    const t = text(table);
    const cells = all(table, 'td').map((td) => td.textContent);
    for (const [code, words] of Object.entries(reasons)) {
      expect(cells).toContain(words);
      expect(cells).not.toContain(code);
    }
    expect(t).not.toContain('Changed since the job wrote it');
    expect(t).not.toContain('People analyzed it in more than one way');
    await v.unmount();
  });

  it('draws no Entries section for a linking job that made no entry', async () => {
    const report = {
      ...REPORT,
      entries: {
        created: [],
        unlinked: [],
        createdMore: 0,
        unlinkedMore: 0,
        lexicons: [],
      },
    };
    const job = jobOf({ state: 'cancelled', report });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    expect(all(section, 'h3').map((h) => h.textContent)).not.toContain('Entries');
    expect(all(section, 'h3').map((h) => h.textContent)).not.toContain('Entries with no links');
    await v.unmount();
  });

  it('leaves out what a job without linking did not do, and says when core stopped it', async () => {
    const report = {
      ...REPORT,
      stopped: 'without-worker',
      summary: null,
      summaryFailed: true,
      totals: {
        ...REPORT.totals,
        words: 0,
        links: 0,
        entries: 0,
        proposed: 0,
        deletions: 0,
        repeated: 0,
      },
      harmonize: { changed: [], left: [], changedMore: 0, leftMore: 0 },
      entries: { created: [], unlinked: [], lexicons: [] },
      proposed: [],
      proposedMore: 0,
    };
    const job = jobOf({ state: 'cancelled', report });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    const t = text(section);
    expect(t).toContain('Stopped with no worker running.');
    expect(t).toContain('The summary could not be written.');
    expect(totals(section)['Translations written']).toBe('3');
    expect(totals(section)).not.toHaveProperty('Deletions');
    expect(totals(section)).not.toHaveProperty(
      'Changes left out, sentence written before an interruption',
    );
    expect(all(section, 'h3').map((h) => h.textContent)).not.toContain('Proposed changes');
    expect(totals(section)).not.toHaveProperty('Words analyzed');
    expect(t).not.toContain('Machine drafts');
    expect(t).not.toContain('Analyses made consistent');
    await v.unmount();
  });

  it('says how many values the job set in each field, a row per field', async () => {
    const report = {
      ...REPORT,
      totals: {
        ...REPORT.totals,
        words: 0,
        fields: [
          { field: 'Animacy', id: 'L2', values: 1 },
          { field: 'Thematic role', id: 'L1', values: 1107 },
        ],
      },
    };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    const section = v.container.querySelector('section[aria-label="Report"]');
    const sums = totals(section);
    expect(sums['Thematic role']).toBe('1,107 values');
    expect(sums['Animacy']).toBe('1 value');
    expect(sums).not.toHaveProperty('Words analyzed');
    const labels = all(section, 'dl dt').map((dt) => dt.textContent);
    expect(labels.indexOf('Animacy')).toBe(labels.indexOf('Translations replaced') + 1);
    await v.unmount();
    const none = await mount(clientOf(jobOf({ state: 'done', report: REPORT })));
    expect(totals(none.container)).not.toHaveProperty('Thematic role');
    await none.unmount();
  });

  it('sums the documents’ field rows when the totals hold none, as core’s own report does', async () => {
    // REV-L2-4: a job no worker finished has core's report, whose totals sum
    // named keys only, while each document's counts keep its fields.
    const doc = (id, fields) => ({
      ...REPORT.documents[0],
      documentId: id,
      counts: { changes: 3, fields },
    });
    const report = {
      ...REPORT,
      totals: { ...REPORT.totals, fields: undefined },
      documents: [
        doc('a', [{ field: 'Thematic role', id: 'L1', values: 9 }]),
        doc('b', [
          { field: 'Animacy', id: 'L2', values: 2 },
          { field: 'Thematic role', id: 'L1', values: 1 },
        ]),
      ],
    };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    const sums = totals(v.container.querySelector('section[aria-label="Report"]'));
    expect(sums['Thematic role']).toBe('10 values');
    expect(sums['Animacy']).toBe('2 values');
    // By name, as the worker's totals and read_job list them (REV-L2B-10).
    const order = Object.keys(sums);
    expect(order.indexOf('Animacy')).toBeLessThan(order.indexOf('Thematic role'));
    await v.unmount();
  });

  it('sums the documents’ field rows by the target’s id, whatever name each row carries', async () => {
    // REV-SUFIX-2: a row carries the target's id. A field renamed between
    // two documents is one row, named as its first row names it.
    const doc = (id, fields) => ({
      ...REPORT.documents[0],
      documentId: id,
      counts: { changes: 3, fields },
    });
    const report = {
      ...REPORT,
      totals: { ...REPORT.totals, fields: undefined },
      documents: [
        doc('a', [{ field: 'Role', id: 'L1', values: 2 }]),
        doc('b', [
          { field: 'Animacy', id: 'L2', values: 2 },
          { field: 'Thematic role', id: 'L1', values: 3 },
        ]),
      ],
    };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    const sums = totals(v.container.querySelector('section[aria-label="Report"]'));
    expect(sums['Role']).toBe('5 values');
    expect(sums).not.toHaveProperty('Thematic role');
    expect(sums['Animacy']).toBe('2 values');
    await v.unmount();
  });

  // REV-SU-B-4 (the lead's addition): the limit binds the plan, so a job may
  // write a field its setup does not name. The worker marks such a field's
  // row by id (`outside`), and counts what it wrote outside the setup.
  it('marks a field the job wrote outside its setup, and counts the values written outside it', async () => {
    const setup = { fills: [{ id: 'L1', name: 'Thematic role' }], text: false };
    const report = {
      ...REPORT,
      totals: {
        ...REPORT.totals,
        fields: [
          { field: 'Gloss', id: 'L3', values: 1, outside: true },
          { field: 'Thematic role', id: 'L1', values: 9 },
        ],
        outside: [
          { field: 'Gloss', id: 'L3', values: 1 },
          { field: 'Translation', id: 'L4', values: 1 },
        ],
      },
    };
    let v = await mount(clientOf(jobOf({ state: 'done', setup, report })));
    let sums = totals(v.container.querySelector('section[aria-label="Report"]'));
    expect(sums['Gloss']).toBe('1 value, not in the setup');
    expect(sums['Thematic role']).toBe('9 values');
    expect(sums['Values not in the setup']).toBe('2');
    await v.unmount();

    // Core's own report: the documents' rows, summed.
    const doc = (id, counts) => ({ ...REPORT.documents[0], documentId: id, counts });
    const fromRows = {
      ...REPORT,
      totals: { ...REPORT.totals, fields: undefined },
      documents: [
        doc('a', {
          fields: [{ field: 'Gloss', id: 'L3', values: 2, outside: true }],
          outside: [{ field: 'Gloss', id: 'L3', values: 2 }],
        }),
        doc('b', { fields: [{ field: 'Thematic role', id: 'L1', values: 3 }] }),
      ],
    };
    v = await mount(clientOf(jobOf({ state: 'done', setup, report: fromRows })));
    sums = totals(v.container.querySelector('section[aria-label="Report"]'));
    expect(sums['Gloss']).toBe('2 values, not in the setup');
    expect(sums['Thematic role']).toBe('3 values');
    expect(sums['Values not in the setup']).toBe('2');
    await v.unmount();

    v = await mount(clientOf(jobOf({ state: 'done', report: REPORT })));
    expect(totals(v.container)).not.toHaveProperty('Values not in the setup');
    await v.unmount();
  });

  // REV-SUFIX-1: every target the job wrote outside its setup has a row of
  // its own, by id, with the count the worker's `outside` rows give it, a
  // translation and segmentation too, and the total is their sum.
  it('gives each target written outside the setup its own row, and the total sums them', async () => {
    const setup = { fills: [{ id: 'L1', name: 'Thematic role' }], text: false };
    const report = {
      ...REPORT,
      totals: {
        ...REPORT.totals,
        fields: [
          { field: 'Gloss', id: 'L5', values: 1, outside: true },
          { field: 'Thematic role', id: 'L1', values: 9 },
        ],
        outside: [
          { field: 'Gloss', id: 'L5', values: 3 },
          { field: 'Morph Gloss', id: 'L3', values: 2 },
          { field: 'Translation', id: 'L4', values: 1 },
          { field: 'segmentation', id: 'segmentation', values: 1 },
        ],
      },
    };
    let v = await mount(clientOf(jobOf({ state: 'done', setup, report })));
    let sums = totals(v.container.querySelector('section[aria-label="Report"]'));
    expect(sums['Gloss']).toBe('3 values, not in the setup');
    expect(sums['Morph Gloss']).toBe('2 values, not in the setup');
    expect(sums['Translation']).toBe('1 value, not in the setup');
    expect(sums['segmentation']).toBe('1 value, not in the setup');
    expect(sums['Thematic role']).toBe('9 values');
    expect(sums['Values not in the setup']).toBe('7');
    await v.unmount();

    // Core's own report: the documents' rows, summed by id.
    const doc = (id, counts) => ({ ...REPORT.documents[0], documentId: id, counts });
    const fromRows = {
      ...REPORT,
      totals: { ...REPORT.totals, fields: undefined },
      documents: [
        doc('a', { outside: [{ field: 'Morph Gloss', id: 'L3', values: 2 }] }),
        doc('b', {
          fields: [{ field: 'Thematic role', id: 'L1', values: 3 }],
          outside: [{ field: 'Morph Gloss', id: 'L3', values: 1 }],
        }),
      ],
    };
    v = await mount(clientOf(jobOf({ state: 'done', setup, report: fromRows })));
    sums = totals(v.container.querySelector('section[aria-label="Report"]'));
    expect(sums['Morph Gloss']).toBe('3 values, not in the setup');
    expect(sums['Thematic role']).toBe('3 values');
    expect(sums['Values not in the setup']).toBe('3');
    await v.unmount();
  });

  it('lists the changes a write cut short did not write under a line of their own', async () => {
    const report = {
      ...REPORT,
      proposed: [
        ...REPORT.proposed,
        {
          kind: 'rename_entry',
          documentId: null,
          document: null,
          ref: null,
          field: null,
          from: null,
          to: null,
          label: 'Rename entry gam to gaam',
          reason: 'interrupted',
        },
      ],
      proposedMore: 0,
    };
    const job = jobOf({ state: 'done', finishedAt: '2026-11-12T11:00:00Z', report });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    const tables = all(section, 'table').filter((t) => text(t).includes('From'));
    expect(tables).toHaveLength(2);
    expect(text(tables[0])).toContain('rename Story A to Story One');
    expect(text(tables[0])).not.toContain('gaam');
    expect(text(tables[1])).toContain('Rename entry gam to gaam');
    expect(text(tables[1].previousElementSibling)).toBe('Not written, the write was interrupted');
    await v.unmount();
  });

  // R4 (RP-6, RP-2, RP-9): the counted facts first, the worker's own line
  // when people's work or the text changed, then the assistant's account,
  // marked as its own and unchecked, its Markdown rendered as the chat does.
  it('puts the worker’s line first, then the counts, then the assistant’s account as its own', async () => {
    const notice =
      'People’s work: 33 values, morphemes or links people wrote were changed or removed. What the job wrote in their place is unverified.';
    const report = {
      ...REPORT,
      notice,
      summary: 'Filled **Word class** on `doa`.\n\n- first check s3',
      summaryBy: 'model',
    };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    const section = v.container.querySelector('section[aria-label="Report"]');
    const line = section.querySelector('[data-testid="job-notice"]');
    expect(text(line)).toBe(notice);
    const order = [...section.querySelectorAll('[data-testid="job-notice"], h3')].map((el) =>
      el.tagName === 'H3' ? el.textContent : 'notice',
    );
    expect(order.slice(0, 3)).toEqual(['notice', 'Totals', 'Assistant’s summary']);
    const summary = section.querySelector('[data-testid="job-summary"]');
    expect(text(summary.previousElementSibling)).toBe(
      'Written by the assistant, not checked against the counts above.',
    );
    expect(summary.querySelector('strong').textContent).toBe('Word class');
    expect(summary.querySelector('code').textContent).toBe('doa');
    expect(summary.querySelector('li').textContent).toBe('first check s3');
    expect(text(summary)).not.toContain('**');
    await v.unmount();
    // No line when the worker wrote none.
    const plain = await mount(clientOf(jobOf({ state: 'done', report: REPORT })));
    expect(plain.container.querySelector('[data-testid="job-notice"]')).toBeNull();
    await plain.unmount();
  });

  // REV-RPF-W-3: core's own report (a job no worker finished) has no notice:
  // the page builds the worker's line from the counts it has, its documents'
  // where its totals have no count of the text's words.
  it('builds the worker’s top line from the counts of core’s own report', async () => {
    const report = {
      ...REPORT,
      state: 'cancelled',
      stopped: 'without-worker',
      summary: null,
      totals: { ...REPORT.totals, peoplesValuesChanged: 2, textChanges: 1 },
      documents: [
        { documentId: 'd1', name: 'Story A', counts: { wordsAdded: 1, tokensChanged: 1 } },
      ],
    };
    const v = await mount(clientOf(jobOf({ state: 'cancelled', report })));
    expect(text(v.container.querySelector('[data-testid="job-notice"]'))).toBe(
      "People's work: 2 values, morphemes or links people wrote were changed or removed. What the job wrote in their place is unverified. Text: 1 word added, 1 existing word or punctuation mark changed or removed.",
    );
    await v.unmount();
    // A worker's report that says it has no line keeps none.
    const none = await mount(
      clientOf(jobOf({ state: 'done', report: { ...report, state: 'done', notice: null } })),
    );
    expect(none.container.querySelector('[data-testid="job-notice"]')).toBeNull();
    await none.unmount();
  });

  it('renders each piece’s note as the chat renders the assistant’s text', async () => {
    const report = {
      ...REPORT,
      notes: [
        { document: 'd1', name: 'Story A', sentences: 's1 to s5', note: 'Left **s3** blank.' },
      ],
    };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    const section = v.container.querySelector('section[aria-label="Report"]');
    expect(byText(section, 'strong', 's3')).toBeTruthy();
    expect(text(section)).not.toContain('**');
    await v.unmount();
  });

  // A3 (RP-3, RP-6): one definition of changes, said in its parts.
  it('says what the changes written are, in the parts the worker counts', async () => {
    const report = {
      ...REPORT,
      totals: {
        ...REPORT.totals,
        changes: 253,
        changesParts: [
          { kind: 'analyses', n: 102 },
          { kind: 'links', n: 151 },
        ],
      },
    };
    let v = await mount(clientOf(jobOf({ state: 'done', report })));
    expect(totals(v.container)['Changes written']).toBe('253 (102 word analyses and 151 links)');
    await v.unmount();
    // REV-RPF2-2: values set on their own said so beside analyses, and what
    // the analyses hold in the Changes view's nouns, so 3 + 5 values and 5
    // morphemes can be read off the report.
    const held = {
      ...REPORT,
      totals: {
        ...REPORT.totals,
        changes: 6,
        changesParts: [
          { kind: 'values', n: 3 },
          { kind: 'analyses', n: 3, morphemes: 5, values: 5 },
        ],
      },
    };
    v = await mount(clientOf(jobOf({ state: 'done', report: held })));
    expect(totals(v.container)['Changes written']).toBe(
      '6 (3 values on their own and 3 word analyses holding 5 morphemes and 5 values)',
    );
    await v.unmount();
    // The same summed from the documents of core's own report.
    const heldCore = {
      ...REPORT,
      totals: { ...REPORT.totals, changes: 6 },
      documents: ['d1', 'd2'].map((documentId, i) => ({
        documentId,
        name: documentId,
        skipped: [],
        counts: {
          changes: 3,
          changesParts: i
            ? [{ kind: 'values', n: 3 }]
            : [{ kind: 'analyses', n: 3, morphemes: 5, values: 5 }],
        },
      })),
    };
    v = await mount(clientOf(jobOf({ state: 'done', report: heldCore })));
    expect(totals(v.container)['Changes written']).toBe(
      '6 (3 values on their own and 3 word analyses holding 5 morphemes and 5 values)',
    );
    await v.unmount();
    // Core's own report keeps each document's counts: the parts are summed.
    const core = {
      ...REPORT,
      totals: { ...REPORT.totals, changes: 193 },
      documents: [
        {
          documentId: 'd1',
          name: 'Story A',
          skipped: [],
          counts: {
            changes: 190,
            changesParts: [
              { kind: 'values', n: 175 },
              { kind: 'text', n: 14 },
            ],
          },
        },
        {
          documentId: 'd2',
          name: 'Story B',
          skipped: [],
          counts: { changes: 3, changesParts: [{ kind: 'values', n: 3 }] },
        },
      ],
    };
    v = await mount(clientOf(jobOf({ state: 'done', report: core })));
    expect(totals(v.container)['Changes written']).toBe('193 (178 values and 14 text edits)');
    await v.unmount();
    // Every kind has its words.
    const every = {
      ...REPORT,
      totals: {
        ...REPORT.totals,
        changes: 7,
        changesParts: ['values', 'analyses', 'links', 'entries', 'text', 'other'].map((kind) => ({
          kind,
          n: 1,
        })),
      },
    };
    v = await mount(clientOf(jobOf({ state: 'done', report: every })));
    expect(totals(v.container)['Changes written']).toBe(
      '7 (1 value on its own, 1 word analysis, 1 link, 1 lexicon entry, 1 text edit and 1 other change)',
    );
    await v.unmount();
  });

  // A9: what is blank in sentences the job worked and changed nothing in is
  // counted, never listed.
  it('counts apart what is blank in sentences the job did not change', async () => {
    const blank = [{ target: 'Word class', unit: 'word', left: 2, untouched: 45 }];
    const report = {
      ...REPORT,
      totals: { ...REPORT.totals, blank },
      documents: [
        {
          documentId: 'd1',
          name: 'Story A',
          skipped: [],
          left: [
            { ref: 's3.w2', sentenceId: 'sen3', begin: 4, form: 'ka', targets: ['Word class'] },
          ],
          leftMore: 1,
          counts: { blank, leftUnits: [{ unit: 'word', left: 2 }] },
        },
      ],
    };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    const section = v.container.querySelector('section[aria-label="Report"]');
    const sums = totals(section);
    expect(sums['Word class left blank']).toBe('2 words');
    expect(sums['Word class blank in sentences the job did not change']).toBe('45 words');
    expect(text(section)).toContain(
      'Blank in sentences the job did not change: Word class 45 words.',
    );
    await v.unmount();
  });

  // A7: a value refused on a word the job did not add.
  it('words a value refused on a word the job did not add', async () => {
    const report = {
      ...REPORT,
      documents: [
        {
          documentId: 'd1',
          name: 'Story A',
          skipped: [],
          left: [],
          leftMore: 0,
          refused: [{ sentence: 's2', sentenceId: 'sen2', what: 'x', code: 'not-added' }],
        },
      ],
    };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    expect(text(v.container)).toContain('s2 Value on a word or sentence the job did not add');
    await v.unmount();
  });

  // A5, RP-4: the one report of a job that fills nothing, in full, first.
  it('shows the findings of a job that fills nothing first on the page, rendered, with Copy', async () => {
    const findings = '## Part 1\n\n| form | glosses |\n|---|---|\n| на | AOR 78, AOC 22 |\n';
    const report = {
      ...REPORT,
      findings,
      summary: 'The job wrote no change and proposed none.',
      summaryBy: 'worker',
      plan: { pieces: 'selection', by: 'model', fallback: [], leftOut: [], fillsNames: [] },
      totals: { ...REPORT.totals, changes: 0, proposed: 0 },
    };
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    const block = v.container.querySelector('[data-testid="job-findings"]');
    expect(block).not.toBeNull();
    // Before the job's facts and the report.
    const facts = v.container.querySelector('dl');
    expect(block.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block.querySelector('h2, h3').textContent).toBe('Findings');
    // The model's own text, marked as the summary is (REV-RPF-P-4).
    expect(text(block.querySelector('[data-testid="job-findings-by"]'))).toBe(
      'Written by the assistant, not checked against the counts below.',
    );
    expect(block.querySelector('td').textContent).toBe('на');
    expect(text(block)).not.toContain('|---|');
    await v.step(() => byText(block, 'button', 'Copy').click());
    await v.step(async () => {});
    expect(writeText).toHaveBeenCalledWith(findings);
    await v.unmount();
  });

  // REV-RPF-W-2: findings of many pieces not merged say how many pieces they
  // hold and how many did not fit.
  // REV-RPF-W-5: the values an analysis carries count under their field, and
  // the row says how many of them analyses carried.
  it('says how many of a field’s values word analyses carried', async () => {
    const fields = [
      { field: 'Morph Gloss', id: 'mg', values: 8, inAnalyses: 7 },
      { field: 'Gloss', id: 'g', values: 1 },
    ];
    const report = { ...REPORT, totals: { ...REPORT.totals, fields } };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    expect(totals(v.container)['Morph Gloss']).toBe('8 values (7 in word analyses)');
    expect(totals(v.container).Gloss).toBe('1 value');
    await v.unmount();
  });

  it('says how many pieces the findings hold and how many did not fit', async () => {
    const base = {
      ...REPORT,
      summary: 'The job wrote no change and proposed none.',
      summaryBy: 'worker',
      totals: { ...REPORT.totals, changes: 0, proposed: 0 },
    };
    const line = (c) => c.querySelector('[data-testid="job-findings-pieces"]')?.textContent ?? null;
    let v = await mount(
      clientOf(
        jobOf({
          state: 'done',
          report: { ...base, findings: '## Story 1\n\nA.', findingsPieces: 80, findingsCut: 21 },
        }),
      ),
    );
    expect(line(v.container)).toBe(
      'Findings of 59 of 80 pieces are shown here, each under its heading. 21 are left out: each piece’s findings are on its row of the work list.',
    );
    await v.unmount();
    v = await mount(
      clientOf(
        jobOf({
          state: 'done',
          report: { ...base, findings: '## Story 1\n\nA.', findingsPieces: 2, findingsCut: 0 },
        }),
      ),
    );
    expect(line(v.container)).toBe('Findings of 2 pieces, each under its heading.');
    await v.unmount();
    v = await mount(
      clientOf(jobOf({ state: 'done', report: { ...base, findings: 'One report.' } })),
    );
    expect(line(v.container)).toBeNull();
    await v.unmount();
  });

  it('says a plan of all the documents at once that was walked after it so', async () => {
    const plan = (fallback) => ({
      pieces: 'selection',
      by: 'model',
      fallback,
      leftOut: [],
      fillsNames: ['Gloss'],
    });
    let v = await mount(clientOf(jobOf({ state: 'done', report: { ...REPORT, plan: plan([]) } })));
    expect(totals(v.container).Plan).toBe('Worked on all the documents at once. Fills: Gloss.');
    await v.unmount();
    const fallback = [1, 2, 3, 4, 5].map((n) => ({ documentId: `d${n}`, reason: 'walk' }));
    v = await mount(
      clientOf(jobOf({ state: 'done', report: { ...REPORT, plan: plan(fallback) } })),
    );
    expect(totals(v.container).Plan).toBe(
      'Worked on all the documents at once, then 5 in stretches of sentences. Fills: Gloss.',
    );
    await v.unmount();
  });

  // A8 (RP-6): what a job's text edits did to the words, counted by the worker.
  it('counts the words a job added and the existing ones its text edits changed or removed', async () => {
    const report = {
      ...REPORT,
      totals: { ...REPORT.totals, textChanges: 14, wordsAdded: 25, tokensChanged: 2 },
    };
    const v = await mount(clientOf(jobOf({ state: 'done', report })));
    const sums = totals(v.container.querySelector('section[aria-label="Report"]'));
    expect(sums['Words added']).toBe('25');
    expect(sums['Existing words or punctuation marks changed or removed']).toBe('2');
    await v.unmount();
  });

  it('says a job it cannot read is not found', async () => {
    const client = {
      jobs: {
        get: vi.fn(async () => {
          throw Object.assign(new Error('HTTP 403'), { status: 403 });
        }),
      },
    };
    const v = await mount(client);
    expect(text(v.container)).toContain('Job not found.');
    expect(byText(v.container, 'a', 'All jobs').getAttribute('href')).toBe('/projects/p1?tab=jobs');
    await v.unmount();
  });
});
