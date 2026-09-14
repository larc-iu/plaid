import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, texts, byText, all } from '../../test/renderComponent.jsx';

const { toast, confirm } = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  confirm: vi.fn(async () => false),
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('./ConfirmProvider', () => ({ useConfirm: () => confirm }));

const { ProjectInvites } = await import('./ProjectInvites.jsx');

const ROWS = [
  {
    id: 'i1',
    note: 'Fall 2026',
    projectRole: 'writer',
    uses: 0,
    maxUses: 3,
    expiresAt: '2026-12-01T00:00:00Z',
    status: 'active',
  },
  {
    id: 'i2',
    note: '',
    projectRole: 'reader',
    uses: 1,
    maxUses: 1,
    expiresAt: '2026-10-01T00:00:00Z',
    status: 'used',
  },
];

const client = (over = {}) => ({
  invites: { list: async () => ROWS, create: vi.fn(), revoke: vi.fn(), ...over },
});

const mount = (props = {}) =>
  renderComponent(
    <MemoryRouter>
      <ProjectInvites
        projectId="p1"
        projectName="Lezgi"
        client={client()}
        canManage
        roleHints={{ reader: 'Reads.', writer: 'Also edits.', maintainer: 'Also settings.' }}
        {...props}
      />
    </MemoryRouter>,
  );

const typeInto = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
  vi.clearAllMocks();
  confirm.mockResolvedValue(false);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('ProjectInvites', () => {
  it('shows nothing at all to someone who cannot manage the project', async () => {
    const list = vi.fn();
    const { container, unmount } = await mount({ canManage: false, client: client({ list }) });
    expect(container.textContent).toBe('');
    expect(list).not.toHaveBeenCalled();
    await unmount();
  });

  it('lists a link by its label, what it grants, and how far it is used', async () => {
    const { container, unmount } = await mount();
    const rows = all(container, 'tbody tr').map((tr) =>
      [...tr.children].slice(0, 3).map((td) => td.textContent.trim()),
    );
    expect(rows).toEqual([
      ['Fall 2026', 'Writer', '0 / 3'],
      ['Untitled', 'Reader', '1 / 1'],
    ]);
    expect(texts(container, 'tbody tr td:nth-child(5)')).toEqual(['active', 'used']);
    await unmount();
  });

  it('offers a revoke only on a link that is still live', async () => {
    const { container, unmount } = await mount();
    const buttons = all(container, 'tbody tr').map(
      (tr) => tr.querySelector('button[aria-label="Revoke invitation link"]') !== null,
    );
    expect(buttons).toEqual([true, false]);
    await unmount();
  });

  it('asks before revoking, and writes nothing when the answer is no', async () => {
    const revoke = vi.fn();
    const { container, step, unmount } = await mount({ client: client({ revoke }) });

    await step(async () => {
      container.querySelector('button[aria-label="Revoke invitation link"]').click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }));
    expect(revoke).not.toHaveBeenCalled();
    await unmount();
  });

  it('refuses a nonsense number of uses or expiry before asking the server', async () => {
    const create = vi.fn();
    const { container, step, unmount } = await mount({ client: client({ create }) });

    await step(() => byText(container, 'button', 'New link').click());
    await step(() => typeInto(document.querySelector('#invite-uses'), '0'));
    await step(() => byText(document.body, 'button', 'Create link').click());
    expect(create).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Error', {
      description: 'Number of uses must be at least 1',
    });

    await step(() => typeInto(document.querySelector('#invite-uses'), '2'));
    await step(() => typeInto(document.querySelector('#invite-ttl'), ''));
    await step(() => byText(document.body, 'button', 'Create link').click());
    expect(create).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Error', {
      description: 'Expiry must be at least 1 day',
    });
    await unmount();
  });

  it('mints a link and shows it once', async () => {
    const create = vi.fn(async () => ({ code: 'ABC123' }));
    const { container, step, unmount } = await mount({ client: client({ create }) });

    await step(() => byText(container, 'button', 'New link').click());
    await step(() => typeInto(document.querySelector('#invite-note'), '  Field methods  '));
    await step(async () => {
      byText(document.body, 'button', 'Create link').click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(create).toHaveBeenCalledWith({
      projectId: 'p1',
      projectRole: 'writer',
      maxUses: 1,
      ttlDays: 14,
      note: 'Field methods',
    });
    const shown = document.querySelector('input[aria-label="Invitation link"]');
    expect(shown.value).toContain('ABC123');
    await unmount();
  });
});
