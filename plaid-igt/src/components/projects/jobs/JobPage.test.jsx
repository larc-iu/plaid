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
        reason: 'no-clear-majority',
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
        ['Waiting', '2 jobs ahead'],
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
    expect(totals(v.container).Plan).toBe('Worked one document at a time. Text edits allowed.');
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
      'Worked in stretches of sentences. Fills: segmentation, Morph Gloss. Text edits allowed.',
    );
    await v.unmount();
    v = await mount(
      clientOf(jobOf({ state: 'done', report: { ...REPORT, plan: { ...plan, fillsNames: [] } } })),
    );
    expect(totals(v.container).Plan).toBe(
      'Worked in stretches of sentences. Fills nothing. Text edits allowed.',
    );
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

  it('shows the totals first and the assistant’s summary after them, under its heading', async () => {
    const v = await mount(clientOf(jobOf({ state: 'done', report: REPORT })));
    const report = v.container.querySelector('section[aria-label="Report"]');
    const headings = all(report, 'h3').map((h) => h.textContent);
    expect(headings.indexOf('Totals')).toBe(0);
    expect(headings.indexOf('Assistant’s summary')).toBe(1);
    const summary = report.querySelector('[data-testid="job-summary"]');
    expect(summary.previousElementSibling.textContent).toBe('Assistant’s summary');
    expect(text(summary)).toBe('The job glossed Story A and proposed one change.');
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
    expect(summary.previousElementSibling.textContent).toBe('Assistant’s summary');
    expect(text(summary)).toBe('Ka is glossed go three times and come once.');
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
    expect(t).toContain('No two-thirds majority');
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
    expect(text(report.querySelector('[data-testid="job-summary"]'))).toBe(
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
      totals: { ...REPORT.totals, fields: [{ field: 'Morph POS', values: 6 }], blank },
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
    expect(sums['Changes to values people wrote']).toBe('3');
    expect(sums['Changes to the text']).toBe('1');
    const headers = all(v.container, 'th').map((h) => h.textContent);
    expect(headers).toContain('Changes to values people wrote');
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
              code: 'lexicon',
            },
            {
              sentence: 's3',
              sentenceId: 'sen3',
              what: 's3.w1 is part of ...',
              code: 'expression',
            },
            { sentence: 's4', sentenceId: null, what: 'something else', code: null },
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
    // A fixed label per kind of refusal, never the model's text (REV-DF-S-4).
    expect(t).toContain('s1 Words changed by the job');
    expect(t).toContain('s2 Lexicon entry changed by the job');
    expect(t).toContain('s3 In a multi-word expression the job made');
    expect(t).toContain('s4 Refused');
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

  it('words every reason a form is left inconsistent', async () => {
    const reasons = {
      'people-differ': 'People analyzed it in more than one way',
      'no-clear-majority': 'No two-thirds majority',
      'in-use': 'Document in use',
      touched: 'Changed since the job wrote it',
      unvouched: 'Not checked',
      commented: 'Has a comment',
      'in-mwe': 'In a multi-word expression',
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
    const t = text(section);
    const cells = all(section, 'td').map((td) => td.textContent);
    for (const [code, words] of Object.entries(reasons)) {
      expect(cells).toContain(words);
      expect(t).not.toContain(` ${code} `);
    }
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
          { field: 'Animacy', values: 1 },
          { field: 'Thematic role', values: 1107 },
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
        doc('a', [{ field: 'Thematic role', values: 9 }]),
        doc('b', [
          { field: 'Animacy', values: 2 },
          { field: 'Thematic role', values: 1 },
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
