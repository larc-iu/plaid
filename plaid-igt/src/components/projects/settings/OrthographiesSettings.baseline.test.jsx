import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The Baseline is the text itself, never stored, marked by a flag, and drawn
// apart from the list. An orthography a project calls Baseline is an
// orthography like any other: it is a row of the list, kept on save, and can
// be removed.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const { OrthographiesSettings } = await import('./OrthographiesSettings.jsx');

const role = (r, extra = {}) => ({ plaid: { role: r }, ...extra });
const project = (orthographies) => ({
  id: 'p1',
  config: {},
  textLayers: [
    {
      id: 'text',
      config: role('baseline'),
      tokenLayers: [
        { id: 'sent', config: role('sentence'), spanLayers: [] },
        { id: 'word', config: role('word', { igt: { orthographies } }), spanLayers: [] },
      ],
    },
  ],
});

const fakeClient = (orthographies) => {
  const writes = [];
  return {
    writes,
    projects: { get: async () => project(orthographies) },
    tokenLayers: {
      setConfig: async (...a) => {
        writes.push(a);
      },
    },
    query: async () => ({ results: [[0]] }),
  };
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
// The list's rows: the Baseline is drawn apart, never as one of them.
const rowNames = () => all(document.body, '[data-orth-row]').map((el) => el.textContent.trim());

afterEach(() => vi.clearAllMocks());

describe('Settings > Orthographies, an orthography named Baseline', () => {
  it('is a row of the list and kept when another is added', async () => {
    const client = fakeClient([{ name: 'Baseline' }, { name: 'IPA' }]);
    const view = await renderComponent(
      <OrthographiesSettings project={await client.projects.get()} client={client} />,
    );
    await view.step(settle);
    expect(rowNames()).toEqual(['Baseline', 'IPA']);
    expect(all(document.body, '[data-orth-row]').map((r) => !!r.querySelector('button'))).toEqual([
      true,
      true,
    ]);
    expect(document.querySelector('[data-orth-block="baseline"] button')).toBeNull();

    const input = document.querySelector('[data-orth-block="additional"] input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await view.step(() => {
      setter.call(input, 'Latin');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await view.step(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
    });
    expect(client.writes.at(-1).slice(0, 4)).toEqual([
      'word',
      'igt',
      'orthographies',
      [{ name: 'Baseline' }, { name: 'IPA' }, { name: 'Latin' }],
    ]);
    await view.unmount();
  });

  it('can be removed, and the Baseline stays', async () => {
    const client = fakeClient([{ name: 'Baseline' }, { name: 'IPA' }]);
    const view = await renderComponent(
      <OrthographiesSettings project={await client.projects.get()} client={client} />,
    );
    await view.step(settle);
    const remove = all(document.body, '[data-orth-row]')[0].querySelector(
      'button[aria-label^="Remove"], button[title^="Remove"]',
    );
    await view.step(async () => {
      remove.click();
      await settle();
    });
    const confirm = all(document.body, 'button').find((b) => b.textContent.trim() === 'Remove');
    await view.step(async () => {
      confirm.click();
      await settle();
    });
    expect(client.writes.at(-1)[3]).toEqual([{ name: 'IPA' }]);
    expect(rowNames()).toEqual(['IPA']);
    expect(document.querySelector('[data-orth-block="baseline"]')).not.toBeNull();
    await view.unmount();
  });
});
