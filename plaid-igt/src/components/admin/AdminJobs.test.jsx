import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { AdminJobs } from './AdminJobs.jsx';

// Admin > Jobs: every project's jobs in one list and whether a job worker is
// running. Each row leads to the job's own page.

const job = (over) => ({
  id: 'j1',
  project: 'P',
  projectName: 'Arapaho',
  state: 'done',
  instructions: 'Gloss the words.',
  documentCount: 2,
  startedBy: 'a@b.com',
  startedByName: 'Ann',
  model: 'm1',
  createdAt: '2026-11-19T10:00:00Z',
  finishedAt: '2026-11-19T10:30:00Z',
  lapsed: false,
  ...over,
});

const mount = async (jobs, worker) => {
  const client = {
    admin: { jobs: async () => jobs },
    jobs: { worker: async () => worker },
  };
  const view = await renderComponent(
    <MemoryRouter>
      <AdminJobs client={client} />
    </MemoryRouter>,
  );
  for (let i = 0; i < 3; i++) await view.step(async () => {});
  return view;
};
const rows = () => all(document.body, 'tbody tr').map((tr) => [...tr.querySelectorAll('td')]);
const workerText = () => document.body.querySelector('[data-worker]').textContent;

describe('Admin jobs', () => {
  it('lists every project’s jobs, each a link to its page, its project to the project’s jobs', async () => {
    const view = await mount(
      [
        job({
          id: 'j2',
          project: 'Q',
          projectName: 'Blackfoot',
          createdAt: '2026-11-19T11:00:00Z',
        }),
        job({ undone: { at: '2026-11-19T12:00:00Z' } }),
      ],
      { seenAt: new Date().toISOString(), model: 'm1' },
    );
    expect(all(document.body, 'thead th').map((th) => th.textContent)).toEqual([
      'State',
      'Project',
      'Instructions',
      'Documents',
      'Started by',
      'Model',
      'Queued',
      'Ended',
    ]);
    const [first, second] = rows();
    expect(first[1].textContent).toBe('Blackfoot');
    expect(first[1].querySelector('a').getAttribute('href')).toBe('/projects/Q?tab=jobs');
    expect(first[0].querySelector('a').getAttribute('href')).toBe('/projects/Q/jobs/j2');
    expect(second[0].textContent).toBe('Done Undone');
    expect(second[4].textContent).toBe('Ann');
    expect(second[5].textContent).toBe('m1');
    expect(workerText()).toBe('A job worker is running (m1).');
    await view.unmount();
  });

  it('says what a running worker runs on a second line, each fact only when sent', async () => {
    const settings = {
      version: '0.0.0+3fa9c2d1',
      modelPool: 'reallms',
      contextWindow: 196608,
      maxOutputTokens: 65536,
      pieceOutputTokens: 4000,
      reasoningEffort: 'low',
      apps: ['igt'],
    };
    const view = await mount([], { seenAt: new Date().toISOString(), model: 'm1', settings });
    const facts = () =>
      [...document.body.querySelectorAll('[data-worker-settings] [data-fact]')].map(
        (f) => f.textContent,
      );
    expect(facts()).toEqual([
      'Version 0.0.0+3fa9c2d1',
      'Model key reallms',
      'Context window 196,608 tokens',
      'Output limit 65,536 tokens',
      'Piece output limit 4,000 tokens',
      'Reasoning effort low',
      'Apps igt',
    ]);
    await view.unmount();
    const some = await mount([], {
      seenAt: new Date().toISOString(),
      model: 'm1',
      settings: { version: '1+aa', maxOutputTokens: 100 },
    });
    expect(facts()).toEqual(['Version 1+aa', 'Output limit 100 tokens']);
    await some.unmount();
  });

  it('shows no settings once the worker is not running', async () => {
    const view = await mount([], {
      seenAt: '2020-01-01T00:00:00Z',
      model: 'm1',
      settings: { version: '1+aa' },
    });
    expect(document.body.querySelector('[data-worker-settings]')).toBeNull();
    await view.unmount();
  });

  it('says a running job’s worker has gone silent', async () => {
    const view = await mount(
      [job({ state: 'running', lapsed: true, heartbeatAt: null, finishedAt: null })],
      { seenAt: null, model: null },
    );
    expect(rows()[0][0].textContent).toBe('Running No worker has reported.');
    expect(workerText()).toBe('No job worker has asked for work since the server started.');
    await view.unmount();
  });

  it('says when the last worker asked for work once none is running', async () => {
    const view = await mount([], { seenAt: '2020-01-01T00:00:00Z', model: 'm1' });
    expect(workerText()).toMatch(
      /^No job worker is running\. The last one asked for work .+ ago\.$/,
    );
    expect(document.body.textContent).toContain('No jobs.');
    await view.unmount();
  });
});
