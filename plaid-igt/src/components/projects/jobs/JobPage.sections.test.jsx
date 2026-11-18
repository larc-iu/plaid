import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderComponent, byText, all } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';

// The job page in sections (`?view=`): the sections an ended job draws and the
// ones it does not, an address naming an absent one, the Overview's state
// line, instructions, headline, To check list, totals in two groups and folded
// summary, the Documents filter, and the pagers of the long lists, each in
// the address.
const auth = vi.hoisted(() => ({ user: { id: 'w', isAdmin: false } }));
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/utils/feedback', () => ({ notifyError: vi.fn() }));
const { JobPage } = await import('./JobPage.jsx');

const PROJECT = { id: 'p1', maintainers: ['m'], writers: ['w'], readers: [], vocabs: [] };

// A document of the job, and its row in the report.
const doc = (i, over = {}) => ({
  documentId: `d${i}`,
  name: `Story ${String(i).padStart(2, '0')}`,
  position: i,
  state: 'done',
  sentences: 4,
  targets: 4,
  done: 4,
  counts: { changes: 2, translations: 2 },
  skipped: [],
  ...over,
});
const reportDoc = (i, over = {}) => ({
  documentId: `d${i}`,
  name: `Story ${String(i).padStart(2, '0')}`,
  state: 'done',
  counts: {
    changes: 2,
    blank: [{ target: 'Translation', unit: 'sentence', left: 0, untouched: 1 }],
    leftUnits: [],
  },
  skipped: [],
  left: [],
  ...over,
});

// A translation job of 30 documents: the first in use, the second with a
// sentence skipped, each done one with a sentence blank it did not change.
const N = 30;
const ENDED = {
  id: 'j1',
  project: 'p1',
  app: 'igt',
  instructions: 'Write a free translation of every sentence whose translation is empty.',
  startedBy: 'w',
  startedByName: 'Wren',
  state: 'done',
  phase: null,
  model: 'glm',
  createdAt: '2026-11-12T10:00:00Z',
  startedAt: '2026-11-12T10:01:00Z',
  finishedAt: '2026-11-12T10:03:30Z',
  documents: [
    doc(1, { state: 'in-use', done: 0, counts: {} }),
    ...Array.from({ length: N - 1 }, (_, k) => doc(k + 2)),
  ],
  report: {
    summary: 'Translated the stories.',
    summaryBy: 'model',
    plan: { pieces: 'document', by: 'model', fallback: [], fillsNames: ['Translation'] },
    totals: {
      documentsDone: N - 1,
      documentsInUse: 1,
      sentences: 58,
      changes: 58,
      translations: 58,
      skippedTooLong: 1,
      blank: [{ target: 'Translation', unit: 'sentence', left: 0, untouched: N - 1 }],
    },
    documents: [
      reportDoc(1, { state: 'in-use', counts: {} }),
      reportDoc(2, {
        skipped: [{ sentence: 's3', sentenceId: 'sen3', reason: 'too-long', kind: null }],
      }),
      ...Array.from({ length: N - 2 }, (_, k) => reportDoc(k + 3)),
    ],
  },
};

const piece = (i, docIndex) => ({
  seq: String(i).padStart(6, '0'),
  piece: {
    document: `d${docIndex}`,
    name: `Story ${String(docIndex).padStart(2, '0')}`,
    first: 's1',
    last: 's4',
    counts: { analyzed: 2, changes: 2 },
    note: `Note ${i}.`,
    steps: 2,
    endedAt: '2026-11-12T10:02:00Z',
  },
});

const clientOf = (job, entries = []) => ({
  jobs: {
    get: vi.fn(async () => job),
    piecesPage: vi.fn(async () => ({ entries, nextCursor: null })),
    cancel: vi.fn(),
  },
  messages: { discoverServices: vi.fn(async () => []) },
});

// Where the page's address is, as the router has it.
let at = null;
const Where = () => {
  const location = useLocation();
  at = `${location.pathname}${location.search}`;
  return null;
};

const mount = (client, query = '') =>
  renderComponent(
    <MemoryRouter initialEntries={[`/projects/p1/jobs/j1${query}`]}>
      <ConfirmProvider>
        <JobPage project={PROJECT} projectId="p1" jobId="j1" client={client} />
        <Where />
      </ConfirmProvider>
    </MemoryRouter>,
  );

const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const panel = (root) => root.querySelector('[role="tabpanel"]');
const tabs = (root) => all(root, '[role="tab"]').map(text);
const tab = (root, label) =>
  all(root, '[role="tab"]').find((t) => text(t).startsWith(label)) ?? null;
// A click as Radix takes it: it acts on mousedown.
const press = (el) => {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  el.click();
};

beforeEach(() => {
  auth.user = { id: 'w', isAdmin: false };
  localStorage.clear();
  at = null;
});

describe('the sections of an ended job', () => {
  it('draws each section that holds something, with its count, and none that is empty', async () => {
    const v = await mount(clientOf(ENDED, [piece(1, 2), piece(2, 3)]));
    expect(tabs(v.container)).toEqual([
      'Overview',
      `Documents${N}`,
      'Notes2',
      // Blank places come in two kinds and units: no one count (REV-RP-3).
      'Blank',
      'Skipped1',
      'Setup',
    ]);
    await v.unmount();
    // No work rows, nothing left blank, nothing skipped: none of those.
    const bare = {
      ...ENDED,
      report: {
        ...ENDED.report,
        totals: { ...ENDED.report.totals, skippedTooLong: 0, blank: [] },
        documents: ENDED.report.documents.map((d) => ({ ...d, skipped: [], counts: {} })),
      },
    };
    const w = await mount(clientOf(bare));
    expect(tabs(w.container)).toEqual(['Overview', `Documents${N}`, 'Setup']);
    await w.unmount();
  });

  it('opens the section the address names, and Overview for one the job does not have', async () => {
    const v = await mount(clientOf(ENDED, [piece(1, 2)]), '?view=skipped');
    expect(panel(v.container).getAttribute('data-view')).toBe('skipped');
    expect(text(panel(v.container))).toContain('s3 Too long');
    await v.unmount();
    // Proposed: this job proposed nothing.
    const w = await mount(clientOf(ENDED, [piece(1, 2)]), '?view=proposed');
    expect(panel(w.container).getAttribute('data-view')).toBe('overview');
    expect(at).toBe('/projects/p1/jobs/j1');
    await w.unmount();
  });

  it('keeps each section in the address, a link of its own, and drops a list’s page on leaving it', async () => {
    const v = await mount(clientOf(ENDED, [piece(1, 2)]), '?view=blank&page=2');
    expect(tab(v.container, 'Notes').getAttribute('href')).toBe('/projects/p1/jobs/j1?view=notes');
    expect(tab(v.container, 'Overview').getAttribute('href')).toBe('/projects/p1/jobs/j1');
    await v.step(() => press(tab(v.container, 'Setup')));
    expect(at).toBe('/projects/p1/jobs/j1?view=setup');
    expect(panel(v.container).getAttribute('data-view')).toBe('setup');
    await v.unmount();
  });
});

describe('the Overview of an ended job', () => {
  it('says its state, when it ended, how long it took and who started it', async () => {
    const v = await mount(clientOf(ENDED));
    expect(text(v.container.querySelector('[data-testid="job-ended"]'))).toMatch(
      /^Ended .+ · took 2 min · started by you$/,
    );
    await v.unmount();
  });

  it('says what the job changed in one sentence, then what to check, each a link to its section', async () => {
    const v = await mount(clientOf(ENDED, [piece(1, 2)]));
    expect(text(v.container.querySelector('[data-testid="job-headline"]'))).toBe(
      `Changed 58 sentences in ${N - 1} of ${N} documents.`,
    );
    const list = v.container.querySelector('[data-testid="job-to-check"]');
    const rows = all(list, 'li').map((li) => [
      text(li.querySelector('span')),
      li.querySelector('a')?.getAttribute('href') ?? null,
    ]);
    expect(rows).toEqual([
      ['1 document in use, not worked', '/projects/p1/jobs/j1?view=documents&filter=in-use'],
      ['1 sentence skipped, too long', '/projects/p1/jobs/j1?view=skipped'],
      [
        `${N - 1} sentences with Translation blank in sentences the job did not change, in ${N - 1} documents`,
        '/projects/p1/jobs/j1?view=blank',
      ],
    ]);
    expect(all(list, 'a').map(text)).toEqual(['Show', 'Show', 'Show']);
    await v.unmount();
  });

  it('draws no To check list for an undone job', async () => {
    const undone = {
      ...ENDED,
      undone: { operation: 'op1', time: '2026-11-12T12:00:00Z', user: 'w' },
    };
    const client = clientOf(undone);
    client.documents = { auditPage: vi.fn(async () => ({ entries: [] })) };
    const v = await mount(client);
    expect(text(v.container.querySelector('[data-testid="job-headline"]'))).toBe(
      `Changed 58 sentences in ${N - 1} of ${N} documents, then undone.`,
    );
    expect(byText(v.container, 'h3', 'To check')).toBeNull();
    expect(byText(v.container, 'h3', 'What the job had written')).not.toBeNull();
    await v.unmount();
  });

  // REV-RP-4: what the page knows of an ended job with no report is its
  // documents' rows: it says what they hold and claims nothing else.
  it('draws the documents to check of an ended job with no report, and no Nothing.', async () => {
    const failed = {
      ...ENDED,
      state: 'failed',
      reason: 'starter-access',
      documents: [doc(1, { state: 'not-reached', done: 0, counts: { changes: 3 } }), doc(2)],
      report: null,
    };
    const v = await mount(clientOf(failed));
    expect(all(v.container, '[data-testid="job-to-check"] li > span').map(text)).toEqual([
      '1 document stopped partway',
    ]);
    expect(byText(v.container, 'h3', 'Totals')).toBeNull();
    await v.unmount();
    const clean = { ...failed, documents: [doc(1), doc(2)] };
    const w = await mount(clientOf(clean));
    expect(byText(w.container, 'h3', 'To check')).toBeNull();
    expect(text(w.container)).not.toContain('Nothing.');
    await w.unmount();
  });

  it('says Nothing. when nothing needs a person', async () => {
    const clean = {
      ...ENDED,
      documents: ENDED.documents.slice(2),
      report: {
        ...ENDED.report,
        totals: { ...ENDED.report.totals, documentsInUse: 0, skippedTooLong: 0, blank: [] },
        documents: ENDED.report.documents.slice(2).map((d) => ({ ...d, counts: {} })),
      },
    };
    const v = await mount(clientOf(clean));
    expect(v.container.querySelector('[data-testid="job-to-check"]')).toBeNull();
    const heading = byText(v.container, 'h3', 'To check');
    expect(text(heading.nextElementSibling)).toBe('Nothing.');
    await v.unmount();
  });

  it('puts the totals in two groups, what was written and what was not', async () => {
    const v = await mount(clientOf(ENDED));
    const groups = all(v.container, 'dl').map((dl) => [
      text(dl.previousElementSibling),
      all(dl, 'dt').map(text),
    ]);
    expect(groups).toEqual([
      [
        'Written',
        ['Documents done', 'Sentences written in', 'Changes written', 'Translations written'],
      ],
      [
        'Not written',
        [
          'Documents in use',
          'Translation left blank in sentences the job changed',
          'Translation blank in sentences the job did not change',
          'Sentences skipped as too long',
        ],
      ],
    ]);
    await v.unmount();
  });

  it('shows two lines of long instructions, and all of them on Show all', async () => {
    const long = { ...ENDED, instructions: 'Translate every sentence plainly. '.repeat(8).trim() };
    const v = await mount(clientOf(long));
    const box = v.container.querySelector('[data-testid="job-instructions"]');
    expect(box.querySelector('p').className).toContain('line-clamp-2');
    await v.step(() => byText(box, 'button', 'Show all').click());
    expect(box.querySelector('p').className).not.toContain('line-clamp-2');
    expect(byText(box, 'button', 'Show less')).toBeTruthy();
    await v.unmount();
    // Short ones have no control.
    const w = await mount(clientOf(ENDED));
    const short = w.container.querySelector('[data-testid="job-instructions"]');
    expect(short.querySelector('button')).toBeNull();
    expect(short.querySelector('p').className).not.toContain('line-clamp-2');
    await w.unmount();
  });

  it('folds a long summary with Show all, its headings under the page’s own', async () => {
    const summary = `## What was done\n\n${'Every sentence was translated from its glosses. '.repeat(20)}`;
    const v = await mount(clientOf({ ...ENDED, report: { ...ENDED.report, summary } }));
    const box = v.container.querySelector('[data-testid="job-summary"]');
    expect(box.className).toContain('max-h-60');
    expect(box.className).toContain('[&_h2]:text-sm');
    // (The test DOM's sanitizer drops the heading's tag: the page draws it.)
    expect(text(box)).toContain('What was done');
    await v.step(() => byText(v.container, 'button', 'Show all').click());
    expect(box.className).not.toContain('max-h-60');
    await v.unmount();
    // A short one is not folded.
    const w = await mount(clientOf(ENDED));
    expect(w.container.querySelector('[data-testid="job-summary"]').className).not.toContain(
      'max-h-60',
    );
    expect(byText(w.container, 'button', 'Show all')).toBeNull();
    await w.unmount();
  });
});

describe('the lists of an ended job', () => {
  it('filters the documents to those to check, the filter in the address', async () => {
    const v = await mount(clientOf(ENDED), '?view=documents&filter=check');
    const names = () => all(v.container, 'tbody tr').map((r) => text(all(r, 'td')[1]));
    expect(names()).toHaveLength(N);
    // Every document is to check here: drop the blanks the job left alone.
    await v.unmount();
    const fewer = {
      ...ENDED,
      report: {
        ...ENDED.report,
        totals: { ...ENDED.report.totals, blank: [] },
        documents: ENDED.report.documents.map((d) => ({ ...d, counts: { changes: 2 } })),
      },
    };
    const w = await mount(clientOf(fewer), '?view=documents&filter=check');
    const rows = () => all(w.container, 'tbody tr');
    expect(rows().map((r) => text(all(r, 'td')[1]))).toEqual(['Story 01', 'Story 02']);
    expect(rows().map((r) => text(all(r, 'td').at(-1)))).toEqual([
      'In use, not worked',
      '1 sentence skipped',
    ]);
    await w.step(() => byText(w.container, 'button', 'All').click());
    expect(at).toBe('/projects/p1/jobs/j1?view=documents');
    expect(rows()).toHaveLength(N);
    await w.step(() => byText(w.container, 'button', 'To check').click());
    expect(at).toBe('/projects/p1/jobs/j1?view=documents&filter=check');
    await w.unmount();
  });

  // REV-RP-2: a To check row's Show opens exactly the documents it counts.
  it('filters the documents to one reason, from a To check row, To check still meaning all', async () => {
    const v = await mount(clientOf(ENDED));
    const show = byText(v.container, 'a', 'Show');
    expect(show.getAttribute('aria-label')).toBe('Show: 1 document in use, not worked');
    await v.unmount();
    const w = await mount(clientOf(ENDED), '?view=documents&filter=in-use');
    const rows = all(w.container, 'tbody tr');
    expect(rows.map((r) => text(all(r, 'td')[1]))).toEqual(['Story 01']);
    // The reason is the filter's third choice, chosen.
    const chosen = all(w.container, 'button[aria-pressed="true"]').map(text);
    expect(chosen).toEqual(['In use1']);
    await w.step(() => byText(w.container, 'button', 'To check').click());
    expect(at).toBe('/projects/p1/jobs/j1?view=documents&filter=check');
    expect(all(w.container, 'tbody tr')).toHaveLength(N);
    await w.unmount();
    // A reason no document has opens All.
    const x = await mount(clientOf(ENDED), '?view=documents&filter=refused');
    expect(all(x.container, 'tbody tr')).toHaveLength(N);
    await x.unmount();
  });

  it('pages Left blank at 25 documents, the page in the address', async () => {
    const v = await mount(clientOf(ENDED), '?view=blank');
    const names = () => all(panel(v.container), 'p > span.font-medium').map(text);
    expect(names()).toHaveLength(25);
    expect(text(panel(v.container))).toContain(`1–25 of ${N - 1}`);
    await v.step(() => panel(v.container).querySelector('button[aria-label="Next page"]').click());
    expect(at).toBe('/projects/p1/jobs/j1?view=blank&page=2');
    expect(names()).toHaveLength(N - 1 - 25);
    await v.unmount();
    const w = await mount(clientOf(ENDED), '?view=blank&page=2');
    expect(text(panel(w.container))).toContain(`26–${N - 1} of ${N - 1}`);
    await w.unmount();
  });

  it('pages the notes at 25 and orders them by time or by document, in the address', async () => {
    // Newest first, as the route answers: piece 30 of Story 30 down to piece 1
    // of Story 01... each document once, in reverse.
    const entries = Array.from({ length: N }, (_, k) => piece(N - k, N - k));
    const v = await mount(clientOf(ENDED, entries), '?view=notes');
    const seqs = () =>
      all(panel(v.container), '[data-testid="job-activity"] > li').map((li) => li.dataset.seq);
    expect(seqs()).toHaveLength(25);
    expect(seqs()[0]).toBe('000030');
    await v.step(() => byText(v.container, 'button', 'By document').click());
    expect(at).toBe('/projects/p1/jobs/j1?view=notes&order=document');
    expect(seqs()[0]).toBe('000001');
    await v.step(() => panel(v.container).querySelector('button[aria-label="Next page"]').click());
    expect(at).toBe('/projects/p1/jobs/j1?view=notes&order=document&page=2');
    expect(seqs()).toEqual(['000026', '000027', '000028', '000029', '000030']);
    await v.unmount();
  });
});

describe('a job still running', () => {
  // REV-RP-5: how far it has got, when it started and how long it has run, on
  // the Overview, and its documents in the job's order.
  it('says how far it has got, and lists the documents in the job’s order', async () => {
    const running = {
      ...ENDED,
      state: 'running',
      phase: 'working',
      finishedAt: null,
      report: null,
      documents: [
        doc(1, { name: 'Zebra story' }),
        doc(2, { name: 'Apple story', state: 'working', done: 1 }),
        doc(3, { name: 'Mango story', state: 'waiting', done: 0, counts: {} }),
      ],
    };
    const v = await mount(clientOf(running));
    const facts = Object.fromEntries(
      all(v.container, '[data-testid="job-progress"] dt').map((dt) => [
        text(dt),
        text(dt.nextElementSibling),
      ]),
    );
    expect(facts['Documents done']).toBe('1 of 3');
    expect(facts.Started).toBeTruthy();
    expect(facts.Elapsed).toBeTruthy();
    await v.unmount();
    const w = await mount(clientOf(running), '?view=documents');
    expect(all(w.container, 'tbody tr').map((r) => text(all(r, 'td')[1]))).toEqual([
      'Zebra story',
      'Apple story',
      'Mango story',
    ]);
    expect(all(w.container, 'tbody tr').map((r) => text(all(r, 'td')[0]))).toEqual(['1', '2', '3']);
    await w.unmount();
    // The order a reader picks on one job is not the next job's.
    localStorage.clear();
    const x = await mount(clientOf(running), '?view=documents');
    await x.step(() => byText(x.container, 'button', 'Document').click());
    expect(text(all(x.container, 'tbody tr')[0])).toContain('Apple story');
    await x.unmount();
    const other = { ...running, id: 'j2' };
    const y = await mount(clientOf(other), '?view=documents');
    expect(text(all(y.container, 'tbody tr')[0])).toContain('Zebra story');
    await y.unmount();
  });

  it('draws Overview, Documents and Setup, the work so far on its Overview', async () => {
    const running = {
      ...ENDED,
      state: 'running',
      phase: 'working',
      message: 'Story 03: sentences 1 to 4 of 4.',
      finishedAt: null,
      report: null,
    };
    const v = await mount(clientOf(running, [piece(1, 2)]), '?view=notes');
    expect(tabs(v.container)).toEqual(['Overview', `Documents${N}`, 'Setup']);
    // The address keeps naming Notes, which the job will have once it ends.
    expect(at).toBe('/projects/p1/jobs/j1?view=notes');
    expect(panel(v.container).getAttribute('data-view')).toBe('overview');
    expect(text(v.container.querySelector('[role="status"]'))).toContain(
      'Story 03: sentences 1 to 4 of 4.',
    );
    expect(v.container.querySelector('section[aria-label="Work so far"]')).not.toBeNull();
    expect(v.container.querySelector('[data-testid="job-headline"]')).toBeNull();
    await v.unmount();
  });
});
