import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, byText } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';
import { AdminUsers } from './AdminUsers';

// The create and edit dialogs ask the server for its password minimum.
vi.mock('@ui/hooks/usePasswordMinimum.js', async (orig) => ({
  ...(await orig()),
  usePasswordMinimum: () => null,
}));

// An account's page has an address (`?user=<id>` beside `?tab=users`), so a
// name in the directory is a real link: middle-click and cmd-click open the
// account in a new tab, and a pasted address opens it. Luke, 2026-10-08.

const USERS = [
  { id: 'ada@example.com', displayName: 'Ada Lovelace' },
  { id: 'bob@example.com', displayName: null },
];

const fakeClient = () => ({
  users: {
    list: vi.fn(async () => USERS),
    get: vi.fn(async (id) => {
      const u = USERS.find((x) => x.id === id);
      if (!u) throw Object.assign(new Error('Not found'), { status: 404 });
      return u;
    }),
    avatarUrl: () => null,
    auditPage: vi.fn(async () => ({ entries: [], nextCursor: null })),
  },
  projects: { list: vi.fn(async () => []) },
  apiTokens: { list: vi.fn(async () => []) },
  audit: { tally: vi.fn(async () => []) },
});

const at = (url, client = fakeClient()) =>
  renderComponent(
    <MemoryRouter initialEntries={[url]}>
      <ConfirmProvider>
        <AdminUsers client={client} currentUser={{ id: 'root@example.com', isAdmin: true }} />
      </ConfirmProvider>
    </MemoryRouter>,
  ).then((r) => ({ ...r, client }));

describe('an account has an address', () => {
  it('draws each name as a link to the account, keeping the tab', async () => {
    const { container, unmount } = await at('/admin?tab=users');
    const link = byText(container, 'tbody a', 'Ada Lovelace');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/admin?tab=users&user=ada%40example.com');
    await unmount();
  });

  it('opens the account the address names', async () => {
    const { container, client, unmount } = await at('/admin?tab=users&user=ada%40example.com');
    expect(client.users.get).toHaveBeenCalledWith('ada@example.com');
    expect(container.querySelector('h2').textContent).toContain('Ada Lovelace');
    const back = byText(container, 'a', 'All accounts');
    expect(back.getAttribute('href')).toBe('/admin?tab=users');
    await unmount();
  });

  it('opens the account when its name is clicked', async () => {
    const { container, client, step, unmount } = await at('/admin?tab=users');
    await step(async () => byText(container, 'tbody a', 'Ada Lovelace').click());
    expect(client.users.get).toHaveBeenCalledWith('ada@example.com');
    expect(container.querySelector('h2').textContent).toContain('Ada Lovelace');
    await unmount();
  });

  it('says so when the address names no account', async () => {
    const { container, unmount } = await at('/admin?tab=users&user=nobody%40example.com');
    expect(container.textContent).toContain('There is no account at this address.');
    expect(byText(container, 'a', 'All accounts')).not.toBeNull();
    await unmount();
  });
});
