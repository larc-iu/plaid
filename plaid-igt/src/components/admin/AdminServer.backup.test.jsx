import { afterEach, describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// Back up now on a large database: the server answers once the zip is written,
// minutes later. When a proxy gives up first, or a backup is already running,
// the backup goes on, so the page waits for its file and shows it, instead of
// saying "Failed to back up" over a backup that succeeded (H7-CORE-OPS-2).

const feedback = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));
vi.mock('@/utils/feedback', async () => {
  const errors = await import('@ui/lib/errors.js');
  return { ...feedback, humanizeError: errors.humanizeError };
});
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => async () => true }));

const { AdminServer } = await import('./AdminServer.jsx');

const report = (backups) => ({
  version: '1',
  jvm: {},
  database: {},
  media: { files: 0, bytes: 0 },
  settings: {},
  backup: { enabled: false, retention: 7, time: '03:00', directory: '/b', backups },
});
const zip = (name) => ({ name, bytes: 10, modified: '2026-10-02T03:00:00Z' });

const clientWith = ({ backup, reports }) => {
  const queue = [...reports];
  return {
    admin: {
      server: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])),
      locks: vi.fn(async () => ({ entries: [] })),
      rateLimits: vi.fn(async () => ({ logins: [], ips: [], invites: [] })),
      backup: vi.fn(backup),
    },
  };
};

const button = (name) => all(document.body, 'button').find((b) => b.textContent.trim() === name);

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const run = async (client) => {
  vi.useFakeTimers();
  const view = await renderComponent(
    <MemoryRouter>
      <AdminServer client={client} />
    </MemoryRouter>,
  );
  await view.step(async () => {});
  await view.step(() => button('Back up now').click());
  return view;
};

describe('Back up now', () => {
  it('waits for the file of a backup whose answer was lost, and shows it', async () => {
    const lost = Object.assign(new Error('Request timed out'), { status: 0, method: 'POST' });
    const client = clientWith({
      backup: async () => {
        throw lost;
      },
      reports: [report([]), report([]), report([zip('plaid-backup-20261002-030000.zip')])],
    });
    const view = await run(client);
    expect(button('Backing up…')).toBeTruthy();
    expect(feedback.notifyError).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) await view.step(() => vi.advanceTimersByTimeAsync(15000));
    expect(feedback.notifyError).not.toHaveBeenCalled();
    expect(feedback.notifySuccess).toHaveBeenCalledWith(
      'plaid-backup-20261002-030000.zip',
      'Backup complete',
    );
    expect(document.body.textContent).toContain('plaid-backup-20261002-030000.zip');
    expect(button('Back up now')).toBeTruthy();
    await view.unmount();
  });

  it('waits for the one already running instead of starting another', async () => {
    const running = Object.assign(new Error('A backup is already running'), {
      status: 409,
      method: 'POST',
    });
    const client = clientWith({
      backup: async () => {
        throw running;
      },
      reports: [report([zip('old.zip')]), report([zip('new.zip'), zip('old.zip')])],
    });
    const view = await run(client);
    expect(feedback.notifyWarning).toHaveBeenCalledWith(
      expect.any(String),
      'Backup already running',
    );
    await view.step(() => vi.advanceTimersByTimeAsync(15000));
    expect(client.admin.backup).toHaveBeenCalledTimes(1);
    expect(feedback.notifySuccess).toHaveBeenCalledWith('new.zip', 'Backup complete');
    await view.unmount();
  });

  it('still says a refusal is a failure', async () => {
    const refused = Object.assign(new Error('HTTP 500'), { status: 500, method: 'POST' });
    const client = clientWith({
      backup: async () => {
        throw refused;
      },
      reports: [report([])],
    });
    const view = await run(client);
    await view.step(async () => {});
    expect(feedback.notifyError).toHaveBeenCalledWith(expect.any(String), 'Failed to back up');
    expect(client.admin.server).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
