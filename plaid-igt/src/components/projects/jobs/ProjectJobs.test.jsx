import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The Jobs tab: the project's jobs newest first, every cell a link to the
// job's page, read again while a job is active so its row moves with the
// worker, and the actions it is handed (the Assistant button and the "⋯"
// menu, for a writer) with the one line saying how a job is set up.
const { ProjectJobs } = await import('./ProjectJobs.jsx');
const { JOB_POLL_MS } = await import('@ui/domain/jobs.js');

const job = (id, over = {}) => ({
  id,
  instructions: 'Gloss the words.',
  state: 'done',
  documentCount: 1,
  startedByName: 'Wren',
  createdAt: '2026-11-10T10:00:00Z',
  finishedAt: '2026-11-10T11:00:00Z',
  ...over,
});

const mount = (client, actions = null, assistant = true) =>
  renderComponent(
    <MemoryRouter>
      <ProjectJobs projectId="p1" client={client} actions={actions} assistant={assistant} />
    </MemoryRouter>,
  );

const rows = (root) =>
  all(root, 'tbody tr').map((r) => all(r, 'td').map((td) => td.textContent.trim()));

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('the Jobs tab', () => {
  it('lists the jobs newest first, each cell a link to the job', async () => {
    const client = {
      jobs: {
        list: vi.fn(async () => [
          job('old', { createdAt: '2026-11-01T10:00:00Z', state: 'failed' }),
          job('new', {
            createdAt: '2026-11-11T10:00:00Z',
            state: 'cancelled',
            instructions: 'Segment, gloss and link.',
            documentCount: 1204,
          }),
        ]),
      },
    };
    const v = await mount(client);
    expect(client.jobs.list).toHaveBeenCalledWith('p1');
    const [first, second] = rows(v.container);
    expect(first[0]).toBe('Stopped');
    expect(first[1]).toBe('Segment, gloss and link.');
    expect(first[2]).toBe('1,204');
    expect(first[3]).toBe('Wren');
    expect(second[0]).toBe('Failed');
    expect(second[2]).toBe('1');
    expect(all(v.container, 'thead th').map((th) => th.textContent.trim())).toEqual([
      'State',
      'Instructions',
      'Documents',
      'Started by',
      'Queued',
      'Ended',
    ]);
    const links = all(v.container.querySelector('tbody tr'), 'td a');
    expect(links.length).toBe(6);
    for (const a of links) expect(a.getAttribute('href')).toBe('/projects/p1/jobs/new');
    await v.unmount();
  });

  it('says a job that stands undone beside its state', async () => {
    const undone = { operation: 'o1', time: '2026-11-12T10:00:00Z', user: 'm' };
    const client = {
      jobs: {
        list: vi.fn(async () => [
          job('a', { createdAt: '2026-11-11T10:00:00Z', undone }),
          job('b', { createdAt: '2026-11-01T10:00:00Z' }),
        ]),
      },
    };
    const v = await mount(client);
    const [first, second] = rows(v.container);
    expect(first[0]).toBe('Done Undone');
    expect(second[0]).toBe('Done');
    const mark = v.container.querySelector('tbody tr td [data-undone]');
    expect(mark.className).toContain('text-muted-foreground');
    await v.unmount();
  });

  it('says when there are none, and draws the actions it is handed', async () => {
    const client = { jobs: { list: vi.fn(async () => []) } };
    const v = await mount(client, <button type="button">Assistant</button>);
    expect(v.container.textContent).toContain('No jobs.');
    expect(all(v.container, 'button').some((b) => b.textContent === 'Assistant')).toBe(true);
    await v.unmount();
  });

  // The fact, said once, and no button tells a person to set up a job (the
  // owner, 2026-11-17).
  const LINE = 'A job is set up by asking the assistant.';
  const count = (text, needle) => text.split(needle).length - 1;
  it('says once, above the list, how a job is set up, to whoever is handed the actions', async () => {
    const empty = { jobs: { list: vi.fn(async () => []) } };
    const v = await mount(empty, <button type="button">Assistant</button>);
    const text = v.container.textContent;
    expect(count(text, LINE)).toBe(1);
    expect(v.container.querySelector('h2').parentElement.textContent).toContain(LINE);
    expect(text).not.toMatch(/set up job/i);
    await v.unmount();

    const some = { jobs: { list: vi.fn(async () => [job('j1')]) } };
    const listed = await mount(some, <button type="button">Assistant</button>);
    expect(count(listed.container.textContent, LINE)).toBe(1);
    await listed.unmount();

    // A reader, handed no actions, is not told how to set one up.
    const reader = await mount(empty);
    expect(reader.container.textContent).not.toContain(LINE);
    await reader.unmount();
  });

  // The line holds only where an assistant can be asked (DOC found 4).
  it('says no assistant is online where none is, and nothing before it is known', async () => {
    const empty = { jobs: { list: vi.fn(async () => []) } };
    const none = await mount(empty, <button type="button">More</button>, false);
    expect(none.container.textContent).not.toContain(LINE);
    expect(none.container.querySelector('h2').parentElement.textContent).toContain(
      'No assistant is online.',
    );
    await none.unmount();
    const unknown = await mount(empty, <button type="button">More</button>, null);
    expect(unknown.container.textContent).not.toContain(LINE);
    expect(unknown.container.textContent).not.toContain('No assistant is online.');
    await unknown.unmount();
  });

  it('reads the list again while a job is active, and stops once none is', async () => {
    vi.useFakeTimers();
    const answers = [
      [job('j1', { state: 'running', finishedAt: null })],
      [job('j1', { state: 'done' })],
    ];
    let i = 0;
    const client = { jobs: { list: vi.fn(async () => answers[Math.min(i++, 1)]) } };
    const v = await mount(client);
    expect(rows(v.container)[0][0]).toBe('Running');
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    expect(rows(v.container)[0][0]).toBe('Done');
    await v.step(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 3));
    expect(client.jobs.list).toHaveBeenCalledTimes(2);
    await v.unmount();
  });
});
