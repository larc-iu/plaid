import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all, byText } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';
import { AdminInvites } from './AdminInvites';

const fakeClient = () => ({
  invites: { list: vi.fn(async () => []) },
  projects: { list: vi.fn(async () => [{ id: 'p1', name: 'Pear Stories' }]) },
});

describe('Create links', () => {
  it('ties every label to its field', async () => {
    const { container, step, unmount } = await renderComponent(
      <MemoryRouter initialEntries={['/admin?tab=invites']}>
        <ConfirmProvider>
          <AdminInvites client={fakeClient()} />
        </ConfirmProvider>
      </MemoryRouter>,
    );
    await step(async () => byText(container, 'button', 'Create links').click());
    const dialog = document.querySelector('[role="dialog"]');
    const labels = all(dialog, 'label');
    expect(labels.map((l) => l.textContent)).toEqual([
      'How many',
      'Project',
      'Role',
      'Expires in (days)',
      'Label',
    ]);
    for (const label of labels) {
      const id = label.getAttribute('for');
      expect(id, label.textContent).toBeTruthy();
      const field = document.getElementById(id);
      expect(field, label.textContent).not.toBeNull();
      expect(dialog.contains(field), label.textContent).toBe(true);
    }
    await unmount();
  });
});

describe('the invite list', () => {
  // H12-4: a list that could not be read said "0 invites" and "No invites."
  it('does not say there are none when it could not read them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClient();
    client.invites.list = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 403'), { status: 403 });
    });
    const { container, step, unmount } = await renderComponent(
      <MemoryRouter initialEntries={['/admin?tab=invites']}>
        <ConfirmProvider>
          <AdminInvites client={client} />
        </ConfirmProvider>
      </MemoryRouter>,
    );
    await step(async () => {});
    expect(container.textContent).not.toContain('No invites.');
    expect(container.textContent).not.toMatch(/0 invites/);
    expect(container.textContent).toContain('Not loaded.');
    await unmount();
  });
});
