import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The Server tab says when the backups are broken: the last run failed, or
// nothing has been written for longer than a day while the server was up to
// write it. Backups switched off are not broken.

vi.mock('@/utils/feedback', async () => {
  const errors = await import('@ui/lib/errors.js');
  return {
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
    notifyWarning: vi.fn(),
    humanizeError: errors.humanizeError,
  };
});
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => async () => true }));

const { AdminServer } = await import('./AdminServer.jsx');

const HOUR = 3600 * 1000;
// The server's clock: started at `STARTED`, up for `uptime`.
const STARTED = '2026-11-01T00:00:00Z';
const at = (ms) => new Date(Date.parse(STARTED) + ms).toISOString();

const report = ({ enabled = true, uptime = 2 * HOUR, backups = [], lastRun, ...rest } = {}) => ({
  version: '1',
  jvm: { startedAt: STARTED, uptimeMs: uptime },
  database: {},
  media: { files: 0, bytes: 0 },
  settings: {},
  backup: {
    enabled,
    retention: 7,
    time: '03:00',
    directory: '/b',
    backups,
    ...(lastRun ? { lastRun } : {}),
  },
  ...rest,
});
const zip = (ms) => ({ name: `plaid-backup-${ms}.zip`, bytes: 10, modified: at(ms) });

const fact = (label) => {
  const dt = [...document.querySelectorAll('dt')].find((d) => d.textContent === label);
  return dt ? dt.nextElementSibling.textContent : null;
};
const banners = () =>
  [...document.querySelectorAll('[data-tone="error"]')].map((n) => n.textContent.trim());

const show = async (srv) => {
  const view = await renderComponent(
    <MemoryRouter>
      <AdminServer
        client={{
          admin: {
            server: vi.fn(async () => srv),
            locks: vi.fn(async () => ({ entries: [] })),
            rateLimits: vi.fn(async () => ({ logins: [], ips: [], invites: [] })),
          },
        }}
      />
    </MemoryRouter>,
  );
  await view.step(async () => {});
  return view;
};

describe('backup health', () => {
  it('says how the last run ended', async () => {
    const view = await show(
      report({ lastRun: { at: new Date().toISOString(), ok: true, scheduled: true } }),
    );
    expect(fact('Last run')).toMatch(/, Succeeded$/);
    expect(banners()).toEqual([]);
    await view.unmount();
  });

  it('says a run by hand was one', async () => {
    const view = await show(
      report({ lastRun: { at: new Date().toISOString(), ok: true, scheduled: false } }),
    );
    expect(fact('Last run')).toMatch(/, Succeeded, by hand$/);
    await view.unmount();
  });

  it('leaves the row out before the first run', async () => {
    const view = await show(report());
    expect(fact('Last run')).toBeNull();
    expect(banners()).toEqual([]);
    await view.unmount();
  });

  it('shows a red banner when the last run failed', async () => {
    const view = await show(
      report({
        backups: [zip(HOUR)],
        lastRun: { at: at(HOUR), ok: false, scheduled: true },
      }),
    );
    expect(fact('Last run')).toMatch(/, Failed$/);
    expect(banners()).toEqual(['The last backup failed.']);
    await view.unmount();
  });

  it('shows a red banner when the newest backup is over 26 hours old', async () => {
    const view = await show(report({ uptime: 30 * HOUR, backups: [zip(3 * HOUR)] }));
    expect(banners()).toEqual(['No backup in the last 26 hours.']);
    await view.unmount();
  });

  it('shows it when there is no backup at all after 26 hours up', async () => {
    const view = await show(report({ uptime: 27 * HOUR }));
    expect(banners()).toEqual(['No backup in the last 26 hours.']);
    await view.unmount();
  });

  it('shows none for a server up less than 26 hours', async () => {
    const view = await show(report({ uptime: 25 * HOUR }));
    expect(banners()).toEqual([]);
    await view.unmount();
  });

  it('shows none for a backup within 26 hours', async () => {
    const view = await show(report({ uptime: 30 * HOUR, backups: [zip(5 * HOUR)] }));
    expect(banners()).toEqual([]);
    await view.unmount();
  });

  it('shows none when backups are switched off', async () => {
    const view = await show(
      report({
        enabled: false,
        uptime: 30 * HOUR,
        lastRun: { at: at(HOUR), ok: false, scheduled: false },
      }),
    );
    expect(banners()).toEqual([]);
    await view.unmount();
  });
});

describe('build', () => {
  it('shows the commit the build was made from beside the version', async () => {
    const commit = 'cd03a068a87666a3e4a95204606894e83b766b89';
    const view = await show(report({ version: '0.3.0', commit }));
    expect(fact('Version')).toBe('0.3.0 (cd03a068a)');
    const dd = [...document.querySelectorAll('dt')].find((d) => d.textContent === 'Version');
    expect(dd.nextElementSibling.querySelector(`[title="${commit}"]`)).toBeTruthy();
    await view.unmount();
  });

  it('shows the version alone for a run from source', async () => {
    const view = await show(report({ version: 'dev', commit: null }));
    expect(fact('Version')).toBe('dev');
    await view.unmount();
  });

  it('shows the migrations applied, the newest named', async () => {
    const view = await show(
      report({
        database: {
          migrations: { applied: 47, latest: '20261118153000-spans-statistics-whole' },
        },
      }),
    );
    expect(fact('Migrations')).toBe('47 applied, latest 20261118153000-spans-statistics-whole');
    await view.unmount();
  });
});
