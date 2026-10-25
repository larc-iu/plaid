import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The list is the page's project's. A save reads the page's project again,
// and so does a save refused because someone saved since, which then shows
// the list as that read has it.

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

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const rowNames = () => all(document.body, '.group span.text-sm').map((el) => el.textContent.trim());
const addRow = async (view, name) => {
  const input = document.querySelector('input[placeholder="Enter orthography name"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await view.step(() => {
    setter.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await view.step(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
  });
};

// The page: it holds the project, and onProjectUpdate reads it again.
const Page = ({ client, initial, reads }) => {
  const [p, setP] = useState(initial);
  const reload = async () => {
    reads.push(1);
    const fresh = await client.projects.get();
    setP(fresh);
    return fresh;
  };
  return <OrthographiesSettings project={p} client={client} onProjectUpdate={reload} />;
};

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe("Settings > Orthographies, the page's project", () => {
  it('shows the list the page holds and reads the page again after a save', async () => {
    let stored = [{ name: 'IPA' }];
    const client = {
      projects: { get: vi.fn(async () => project(stored)) },
      tokenLayers: {
        setConfig: vi.fn(async (id, ns, key, value) => {
          stored = value;
        }),
      },
      query: async () => ({ results: [[0]] }),
    };
    const reads = [];
    const view = await renderComponent(
      <Page client={client} initial={project(stored)} reads={reads} />,
    );
    await view.step(settle);
    expect(rowNames()).toEqual(['Baseline', 'IPA']);
    expect(client.projects.get).not.toHaveBeenCalled();
    await addRow(view, 'Latin');
    expect(client.tokenLayers.setConfig.mock.calls[0][3]).toEqual([
      { name: 'IPA' },
      { name: 'Latin' },
    ]);
    expect(reads).toHaveLength(1);
    expect(rowNames()).toEqual(['Baseline', 'IPA', 'Latin']);
    await view.unmount();
  });

  it('reads the page again after a refused save and shows what it holds', async () => {
    const theirs = [{ name: 'IPA' }, { name: 'Cyrillic' }];
    const client = {
      projects: { get: vi.fn(async () => project(theirs)) },
      tokenLayers: {
        setConfig: vi.fn(async () => {
          throw Object.assign(new Error('changed'), { status: 409 });
        }),
      },
      query: async () => ({ results: [[0]] }),
    };
    const reads = [];
    const view = await renderComponent(
      <Page client={client} initial={project([{ name: 'IPA' }])} reads={reads} />,
    );
    await view.step(settle);
    await addRow(view, 'Latin');
    await view.step(settle);
    expect(reads).toHaveLength(1);
    expect(rowNames()).toEqual(['Baseline', 'IPA', 'Cyrillic']);
    await view.unmount();
  });
});
