import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The Baseline row is the text itself, never stored, and marked by a flag.
// An orthography a project calls Baseline is an orthography like any other:
// it is shown, kept on save, and can be removed.

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
const rowNames = () => all(document.body, '.group span.text-sm').map((el) => el.textContent.trim());

afterEach(() => vi.clearAllMocks());

describe('Settings > Orthographies, an orthography named Baseline', () => {
  it('is shown after the Baseline row and kept when another is added', async () => {
    const client = fakeClient([{ name: 'Baseline' }, { name: 'IPA' }]);
    const view = await renderComponent(<OrthographiesSettings projectId="p1" client={client} />);
    await view.step(settle);
    expect(rowNames()).toEqual(['Baseline', 'Baseline', 'IPA']);
    expect(all(document.body, '.group').map((r) => !!r.querySelector('button'))).toEqual([
      false,
      true,
      true,
    ]);

    const input = document.querySelector('input[placeholder="Enter orthography name"]');
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

  it('can be removed, and the Baseline row stays', async () => {
    const client = fakeClient([{ name: 'Baseline' }, { name: 'IPA' }]);
    const view = await renderComponent(<OrthographiesSettings projectId="p1" client={client} />);
    await view.step(settle);
    const remove = all(document.body, '.group')[1].querySelector(
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
    expect(rowNames()).toEqual(['Baseline', 'IPA']);
    await view.unmount();
  });
});
