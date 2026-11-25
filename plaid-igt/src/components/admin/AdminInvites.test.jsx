import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all, byText } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';
import { AdminInvites } from './AdminInvites';
import { notifyError } from '@ui/lib/notify.js';

vi.mock('@ui/lib/notify.js', () => ({ notifyError: vi.fn(), notifySuccess: vi.fn() }));

// A controlled input takes a value through the native setter, or React
// never sees the change.
const typeInto = (el, value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const fakeClient = () => ({
  invites: { list: vi.fn(async () => []) },
  projects: { list: vi.fn(async () => [{ id: 'p1', name: 'Pear Stories' }]) },
});

describe('Create link', () => {
  it('ties every label to its field', async () => {
    const { container, step, unmount } = await renderComponent(
      <MemoryRouter initialEntries={['/admin?tab=invites']}>
        <ConfirmProvider>
          <AdminInvites client={fakeClient()} />
        </ConfirmProvider>
      </MemoryRouter>,
    );
    await step(async () => byText(container, 'button', 'Create link').click());
    const dialog = document.querySelector('[role="dialog"]');
    const labels = all(dialog, 'label');
    expect(labels.map((l) => l.textContent)).toEqual([
      'Uses',
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

describe('Create link expiry', () => {
  // H12-5: 0 or a blank expiry quietly made links that last the server's
  // default of 14 days.
  it.each(['0', '', '366'])('refuses an expiry of "%s" days', async (ttl) => {
    vi.mocked(notifyError).mockClear();
    const client = fakeClient();
    client.invites.create = vi.fn(async () => ({ code: 'c' }));
    const { container, step, unmount } = await renderComponent(
      <MemoryRouter initialEntries={['/admin?tab=invites']}>
        <ConfirmProvider>
          <AdminInvites client={client} />
        </ConfirmProvider>
      </MemoryRouter>,
    );
    await step(async () => byText(container, 'button', 'Create link').click());
    await step(async () => typeInto(document.getElementById('invite-ttl'), ttl));
    const dialog = document.querySelector('[role="dialog"]');
    await step(async () => byText(dialog, 'button', 'Create').click());
    expect(client.invites.create).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith('Between 1 and 365.', 'Check the expiry');
    await unmount();
  });
});

describe('Create link uses', () => {
  // One link with as many uses as asked for, never one link per use.
  it('mints a single link carrying the number of uses', async () => {
    const client = fakeClient();
    client.invites.create = vi.fn(async () => ({ code: 'c' }));
    const { container, step, unmount } = await renderComponent(
      <MemoryRouter initialEntries={['/admin?tab=invites']}>
        <ConfirmProvider>
          <AdminInvites client={client} />
        </ConfirmProvider>
      </MemoryRouter>,
    );
    await step(async () => byText(container, 'button', 'Create link').click());
    await step(async () => typeInto(document.getElementById('invite-uses'), '12'));
    await step(async () => typeInto(document.getElementById('invite-label'), 'Workshop'));
    const key = (el, k) =>
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    await step(async () => key(document.getElementById('invite-project'), 'Enter'));
    const option = all(document.body, '[role="option"]').find(
      (o) => o.textContent === 'No project',
    );
    await step(async () => key(option, 'Enter'));
    const dialog = document.querySelector('[role="dialog"]');
    await step(async () => byText(dialog, 'button', 'Create').click());
    expect(client.invites.create).toHaveBeenCalledTimes(1);
    expect(client.invites.create).toHaveBeenCalledWith({
      ttlDays: 30,
      maxUses: 12,
      note: 'Workshop',
    });
    expect(document.body.textContent).toContain('Link created');
    expect(document.body.textContent).toContain('up to 12 accounts');
    await unmount();
  });
});
