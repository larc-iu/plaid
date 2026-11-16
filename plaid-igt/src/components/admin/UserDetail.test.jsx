import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

vi.mock('@ui/components/shared/ConfirmProvider', () => ({
  useConfirm: () => async () => true,
}));

const { UserDetail } = await import('./UserDetail');

const client = (names) => ({
  users: {
    get: vi.fn(async () => ({ id: 'u@x.com', displayName: 'U' })),
    avatarUrl: () => null,
    auditPage: vi.fn(async () => ({ entries: [], nextCursor: null })),
  },
  projects: {
    list: vi.fn(async () =>
      names.map((name, i) => ({
        id: `p${i}`,
        name,
        readers: ['u@x.com'],
        writers: [],
        maintainers: [],
      })),
    ),
  },
  apiTokens: { list: vi.fn(async () => []) },
  audit: { tally: vi.fn(async () => []) },
});

describe('UserDetail', () => {
  it('lists the account’s projects by name in number order', async () => {
    localStorage.clear();
    const view = await renderComponent(
      <MemoryRouter>
        <UserDetail
          client={client(['(10) Ten', '(2) Two', '(1) One'])}
          userId="u@x.com"
          backTo="/admin/users"
          onEdit={() => {}}
        />
      </MemoryRouter>,
    );
    await view.step(async () => {});
    const table = all(view.container, 'table').find((t) => t.textContent.includes('Role'));
    const names = all(table, 'tbody tr').map((tr) => tr.querySelector('td').textContent.trim());
    expect(names).toEqual(['(1) One', '(2) Two', '(10) Ten']);
    await view.unmount();
  });
});
