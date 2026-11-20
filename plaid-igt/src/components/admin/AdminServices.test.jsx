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

describe('AdminServices projects', () => {
  it('lists a service’s projects by name in number order', async () => {
    const names = ['(10) Ten', '(2) Two', '(1) One'];
    const c = client(Object.fromEntries(names.map((_, i) => [`p${i}`, [svc()]])));
    c.projects.list = vi.fn(async () => names.map((name, i) => project(`p${i}`, name)));
    const view = await render(c);
    const text = view.container.textContent;
    const at = names.map((n) => text.indexOf(n));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at[2]).toBeLessThan(at[1]);
    expect(at[1]).toBeLessThan(at[0]);
  });
});

const headers = (view) =>
  all(view.container, 'thead th')
    .map((th) => th.textContent)
    .filter(Boolean);
const firstRow = (view) => all(view.container, 'tbody tr')[0].querySelectorAll('td');
const cellOf = (view, label) => firstRow(view)[1 + headers(view).indexOf(label)];

describe('AdminServices what each service runs', () => {
  it('shows the model, version and model key after the service, and keeps Tasks', async () => {
    const extras = {
      tasks: ['assist'],
      model: 'openai/x',
      version: '1.0+aa',
      modelPool: 'reallms',
    };
    const view = await render(client({ p1: [svc({ online: true, extras })] }));
    expect(headers(view).slice(0, 5)).toEqual([
      'Service',
      'Model',
      'Version',
      'Model key',
      'Tasks',
    ]);
    expect(cellOf(view, 'Model').textContent).toBe('openai/x');
    expect(cellOf(view, 'Version').textContent).toBe('1.0+aa');
    expect(cellOf(view, 'Model key').textContent).toBe('reallms');
    expect(cellOf(view, 'Tasks').textContent).toBe('assist');
  });

  it('leaves the model key blank when the service named none', async () => {
    const view = await render(client({ p1: [svc({ extras: { version: '1.0+aa' } })] }));
    expect(cellOf(view, 'Model key').textContent).toBe('');
    expect(cellOf(view, 'Model').textContent).toBe('');
  });

  it('says Versions differ when the online registrations disagree on version or model', async () => {
    const differ = await render(
      client({
        p1: [svc({ online: true, extras: { version: '1.0+aa', model: 'm' } })],
        p2: [svc({ online: true, extras: { version: '1.0+bb', model: 'm' } })],
      }),
    );
    expect(cellOf(differ, 'Version').querySelector('[data-differ]').textContent).toBe(
      'Versions differ',
    );
    await differ.unmount();
    const models = await render(
      client({
        p1: [svc({ online: true, extras: { version: '1.0+aa', model: 'm' } })],
        p2: [svc({ online: true, extras: { version: '1.0+aa', model: 'n' } })],
      }),
    );
    expect(cellOf(models, 'Version').textContent).toContain('Versions differ');
    await models.unmount();
  });

  it('says nothing of an offline registration’s older version', async () => {
    const view = await render(
      client({
        p1: [svc({ online: true, extras: { version: '1.0+bb' } })],
        p2: [svc({ online: false, extras: { version: '1.0+aa' } })],
      }),
    );
    expect(cellOf(view, 'Version').textContent).toBe('1.0+bb');
  });

  it('lists in the expanded row each fact a registration registered, and only those', async () => {
    const view = await render(
      client({
        p1: [
          svc({
            online: true,
            extras: {
              model: 'openai/x',
              version: '1.0+aa',
              modelPool: 'reallms',
              maxOutputTokens: 65536,
              contextWindow: 196608,
              reasoningEffort: 'low',
              webSearch: 'brave',
            },
          }),
        ],
        p2: [svc({ extras: { version: '1.0+bb' } })],
      }),
    );
    const facts = all(view.container, '[data-facts]').map((el) =>
      [...el.querySelectorAll('[data-fact]')].map((f) => f.textContent),
    );
    expect(facts).toEqual([
      [
        'Model openai/x',
        'Version 1.0+aa',
        'Model key reallms',
        'Output limit 65,536 tokens',
        'Context window 196,608 tokens',
        'Reasoning effort low',
        'Web search brave',
      ],
      ['Version 1.0+bb'],
    ]);
  });
});

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
