import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The private-data cap is a setting (`[user_data] max_value_mb`), and how long
// an assistant conversation can grow is what an operator raises it for, so the
// Server tab says what the running server enforces.

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

const client = (settings) => ({
  admin: {
    server: vi.fn(async () => ({
      version: '1',
      jvm: {},
      database: {},
      media: { files: 0, bytes: 0 },
      settings,
      backup: { enabled: false, retention: 7, time: '03:00', directory: '/b', backups: [] },
    })),
    locks: vi.fn(async () => ({ entries: [] })),
    rateLimits: vi.fn(async () => ({ logins: [], ips: [], invites: [] })),
  },
});

const fact = (label) => {
  const dt = [...document.querySelectorAll('dt')].find((d) => d.textContent === label);
  return dt ? dt.nextElementSibling.textContent : null;
};

const show = async (settings) => {
  const view = await renderComponent(
    <MemoryRouter>
      <AdminServer client={client(settings)} />
    </MemoryRouter>,
  );
  await view.step(async () => {});
  return view;
};

describe('the Server tab', () => {
  it('shows the private data limit the server enforces', async () => {
    const view = await show({ userDataValueBytes: 20 * 1024 * 1024 });
    expect(fact('Private data limit')).toBe('20 MB per value');
    await view.unmount();
  });

  it('leaves the row out for a server that does not report it', async () => {
    const view = await show({});
    expect(fact('Private data limit')).toBeNull();
    await view.unmount();
  });
});
