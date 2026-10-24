import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, byText } from '@ui/test/renderComponent.jsx';

vi.mock('@ui/components/shared/ConfirmProvider', () => ({
  useConfirm: () => async () => true,
}));

const { AdminServices } = await import('./AdminServices');

// HUNT-recent 5: a service id belongs to the account that first connected it
// (R10), and no screen offered the release when that account was gone or
// was someone else.

const project = (id, name) => ({ id, name });

const client = (services) => {
  return {
    projects: { list: vi.fn(async () => [project('p1', 'Alpha'), project('p2', 'Beta')]) },
    messages: {
      discoverServices: vi.fn(async (pid) => services[pid] || []),
      discardService: vi.fn(async () => {}),
      releaseService: vi.fn(async () => {}),
    },
  };
};

const svc = (over) => ({
  serviceId: 'analyzer',
  serviceName: 'Analyzer',
  online: false,
  lastSeenAt: '2026-10-20T00:00:00Z',
  ...over,
});

const render = async (c) => {
  const view = await renderComponent(
    <MemoryRouter>
      <AdminServices client={c} currentUser={{ id: 'admin@x.com' }} />
    </MemoryRouter>,
  );
  await view.step(async () => {});
  const expand = all(view.container, 'button[aria-label="Expand"]')[0];
  await view.step(async () => expand.click());
  return view;
};

const releaseButtons = (view) =>
  all(view.container, 'button').filter((b) => b.textContent.trim() === 'Release');

describe('AdminServices release', () => {
  it('offers Release for an offline id another account holds, and names the holder', async () => {
    const c = client({
      p1: [svc({ claimedBy: 'gone@x.com' })],
      p2: [svc({ claimedBy: 'admin@x.com' })],
    });
    const view = await render(c);
    expect(byText(view.container, 'td', 'Held by gone@x.com')).not.toBeNull();
    expect(byText(view.container, 'td', 'Held by admin@x.com')).not.toBeNull();
    const buttons = releaseButtons(view);
    expect(buttons).toHaveLength(1);
    await view.step(async () => buttons[0].click());
    expect(c.messages.releaseService).toHaveBeenCalledWith('p1', 'analyzer');
  });

  it('offers no Release for a connected service or an id nobody holds', async () => {
    const c = client({
      p1: [svc({ claimedBy: 'other@x.com', online: true })],
      p2: [svc({})],
    });
    const view = await render(c);
    expect(releaseButtons(view)).toHaveLength(0);
  });

  it('lists a held id whose registration was forgotten, with Release and no Forget', async () => {
    // REV-R4-CORE F3: Forget deleted the only row that carried the Release.
    const c = client({
      p1: [{ serviceId: 'analyzer', online: false, seen: false, claimedBy: 'gone@x.com' }],
    });
    const view = await render(c);
    expect(byText(view.container, 'td', 'Held by gone@x.com')).not.toBeNull();
    const buttons = all(view.container, 'button').map((b) => b.textContent.trim());
    expect(buttons).toContain('Release');
    expect(buttons).not.toContain('Forget');
    expect(buttons).not.toContain('Forget offline');
    expect(view.container.textContent).toContain('0 registrations');
  });
});
