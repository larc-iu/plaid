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

  // H12-3: a revoked token was listed as live, with a Revoke button.
  it('lists only the tokens that still work', async () => {
    localStorage.clear();
    const c = client([]);
    c.apiTokens.list = vi.fn(async () => [
      {
        id: 't1',
        name: 'Parser 1',
        createdAt: '2026-11-01T00:00:00Z',
        revokedAt: '2026-11-02T00:00:00Z',
      },
      { id: 't2', name: 'Glosser', createdAt: '2026-11-03T00:00:00Z', revokedAt: null },
    ]);
    const view = await renderComponent(
      <MemoryRouter>
        <UserDetail client={c} userId="u@x.com" backTo="/admin/users" onEdit={() => {}} />
      </MemoryRouter>,
    );
    await view.step(async () => {});
    expect(view.container.textContent).toContain('Glosser');
    expect(view.container.textContent).not.toContain('Parser 1');
    await view.unmount();
  });

  // REV-HFP-6: with only revoked tokens the page said "No tokens.", where
  // Profile says "No active tokens".
  it('says there are no active tokens when every one was revoked', async () => {
    localStorage.clear();
    const c = client([]);
    c.apiTokens.list = vi.fn(async () => [
      {
        id: 't1',
        name: 'Parser 1',
        createdAt: '2026-11-01T00:00:00Z',
        revokedAt: '2026-11-02T00:00:00Z',
      },
    ]);
    const view = await renderComponent(
      <MemoryRouter>
        <UserDetail client={c} userId="u@x.com" backTo="/admin/users" onEdit={() => {}} />
      </MemoryRouter>,
    );
    await view.step(async () => {});
    expect(view.container.textContent).toContain('No active tokens.');
    await view.unmount();
  });

  it('shows how many of the changes jobs and services made, beside the total', async () => {
    localStorage.clear();
    const c = client([]);
    c.audit.tally = vi.fn(async () => [
      {
        user: { id: 'u@x.com' },
        operations: 12,
        changes: 9,
        delegatedChanges: 4,
        documents: 2,
        firstTs: '2026-11-01T00:00:00Z',
        lastTs: '2026-11-02T00:00:00Z',
      },
    ]);
    const view = await renderComponent(
      <MemoryRouter>
        <UserDetail client={c} userId="u@x.com" backTo="/admin/users" onEdit={() => {}} />
      </MemoryRouter>,
    );
    await view.step(async () => {});
    const stat = (label) =>
      all(view.container, '.rounded-md.border').find((n) => n.firstChild?.textContent === label)
        ?.lastChild?.textContent;
    expect(stat('Changes')).toBe('9');
    expect(stat('By services and jobs')).toBe('4');
    // One person's row, not every person's.
    expect(c.audit.tally).toHaveBeenCalledWith({ userId: 'u@x.com' });
    await view.unmount();
  });
});
