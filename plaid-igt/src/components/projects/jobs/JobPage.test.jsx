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
    changed: 2,
    proposed: 1,
  },
  proposed: [
    {
      kind: 'set_span',
      documentId: 'd1',
      document: 'Story A',
      ref: 's4',
      field: 'Translation',
      from: 'A person wrote this.',
      to: 'Better.',
      label: 'Translation of s4',
      note: 'Translated s4.',
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
      ],
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
    deleted: [],
    unlinked: [{ id: 'e2', lexicon: 'v1', form: 'ra', gloss: 'eat' }],
    createdMore: 3,
    deletedMore: 0,
    unlinkedMore: 0,
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

  it('lists each document the plan left out, in the report and in the documents table', async () => {
    const report = {
      ...REPORT,
      plan: {
        pieces: 'sentences',
        pieceInstructions: '',
        by: 'model',
        fallback: [],
        leftOut: [{ documentId: 'd2', name: null }],
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
    expect(sums['Changes not written, sentence changed meanwhile']).toBe('2');
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
    // Harmonize.
    expect(t).toContain('ka ‘go’');
    expect(t).toContain('A person’s analysis');
    expect(t).toContain('ka ‘come’ ×2');
    expect(t).toContain('No two-thirds majority');
    expect(t).toContain('And 7 more forms.');
    // Entries, each list with its own cut, and the lexicon's machine drafts.
    expect(t).toContain('ka ‘go’');
    expect(t).toContain('And 3 more entries.');
    expect(t).toContain('Machine drafts with no links');
    expect(t).toContain('ra ‘eat’');
    expect(t).not.toContain('Deleted as unlinked');
    // The prose the job wrote, above the sections.
    expect(text(report.querySelector('[data-testid="job-summary"]'))).toBe(
      'The job glossed Story A and proposed one change.',
    );
    // What the job proposed and did not apply, where, from what to what.
    const proposed = text(byText(report, 'table', 'From').closest('table'));
    expect(proposed).toContain('Story A s4');
    expect(proposed).toContain('A person wrote this.');
    expect(proposed).toContain('Better.');
    expect(byText(report, 'a', 'Story A s4').getAttribute('href')).toBe(
      '/projects/p1/documents/d1',
    );
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

  it('lists the targets the job left blank, each linked into the grid, with how many more', async () => {
    const report = {
      ...REPORT,
      documents: [
        {
          documentId: 'd1',
          name: 'Story A',
          skipped: [],
          left: [
            { ref: 's3', sentenceId: 'sen3', begin: null, form: null },
            { ref: 's3.w2', sentenceId: 'sen3', begin: 14, form: 'kata' },
          ],
          leftMore: 4,
        },
        {
          documentId: 'd2',
          name: null,
          skipped: [],
          left: [{ ref: 's1.w1', sentenceId: 'sen1', begin: 0, form: 'ra' }],
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
    expect(t).toContain('s3 Translation');
    expect(t).toContain('s3.w2 kata');
    expect(t).toContain('And 4 more');
    expect(byText(section, 'a', 's3.w2').getAttribute('href')).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=sen3&focusWord=14',
    );
    expect(byText(section, 'a', 's3').getAttribute('href')).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=sen3',
    );
    // A deleted document's are named and not linked, and one with none is not listed.
    expect(t).toContain('Deleted document');
    expect(t).toContain('s1.w1 ra');
    expect(all(section, 'a').find((a) => a.textContent === 's1.w1')).toBeUndefined();
    expect(t).not.toContain('Story C');
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

  it('draws no Entries section for a linking job that made, deleted and left no entry', async () => {
    const report = {
      ...REPORT,
      entries: {
        created: [],
        deleted: [],
        unlinked: [],
        createdMore: 0,
        deletedMore: 0,
        unlinkedMore: 0,
        lexicons: [],
      },
    };
    const job = jobOf({ state: 'cancelled', report });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    expect(all(section, 'h3').map((h) => h.textContent)).not.toContain('Entries');
    await v.unmount();
  });

  it('leaves out what a job without linking did not do, and says when core stopped it', async () => {
    const report = {
      ...REPORT,
      stopped: 'without-worker',
      summary: null,
      summaryFailed: true,
      totals: { ...REPORT.totals, words: 0, links: 0, entries: 0 },
      harmonize: { changed: [], left: [], changedMore: 0, leftMore: 0 },
      entries: { created: [], deleted: [], unlinked: [], lexicons: [] },
    };
    const job = jobOf({ state: 'cancelled', report });
    const v = await mount(clientOf(job));
    const section = v.container.querySelector('section[aria-label="Report"]');
    const t = text(section);
    expect(t).toContain('Stopped with no worker running.');
    expect(t).toContain('The summary could not be written.');
    expect(totals(section)['Translations filled']).toBe('3');
    expect(totals(section)).not.toHaveProperty('Words analyzed');
    expect(t).not.toContain('Machine drafts');
    expect(t).not.toContain('Analyses made consistent');
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
