import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { TagsetsSettings } from './TagsetsSettings.jsx';
import { notifyError } from '@/utils/feedback';

// Closing a list the stored values break: the server is asked first which
// values it would refuse, and the tagset's panel names them, with nothing
// written. A close nothing breaks is saved with its rule.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const project = () => ({
  id: 'p-1',
  config: {
    igt: {
      tagsets: {
        POS: { mode: 'suggest', delimiters: '', values: [{ value: 'N' }, { value: 'V' }] },
      },
    },
  },
  textLayers: [
    {
      id: 'tl',
      config: { plaid: { role: 'baseline' } },
      tokenLayers: [
        {
          id: 'wl',
          config: { plaid: { role: 'word' } },
          spanLayers: [
            {
              id: 'sl-pos',
              name: 'POS',
              config: { igt: { scope: 'Word', tagset: 'POS' } },
              constraints: { igt: [{ type: 'single-span' }] },
            },
          ],
        },
      ],
    },
  ],
});

const makeClient = (answer) => {
  const client = {
    asked: [],
    writes: [],
    projects: {
      setConfig: async (_id, _ns, key, value) => client.writes.push(['setConfig', key, value]),
    },
    spanLayers: {
      setConfig: async () => {},
      setConstraints: async (id, ns, constraints) =>
        client.writes.push(['setConstraints', id, constraints]),
      refusedValues: async (id, rule, options) => {
        client.asked.push([id, rule, options]);
        return answer;
      },
    },
    async batched(fn) {
      const ops = [];
      const queue = (bundle) =>
        new Proxy(
          {},
          {
            get:
              (_, method) =>
              (...args) =>
                ops.push(() => this[bundle][method](...args)),
          },
        );
      fn({ projects: queue('projects'), spanLayers: queue('spanLayers') });
      for (const op of ops) await op();
      return [];
    },
  };
  return client;
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const close = async (client) => {
  const view = await renderComponent(
    <TagsetsSettings
      project={project()}
      projectId="p-1"
      client={client}
      onProjectUpdate={async () => {}}
    />,
  );
  const { container, step } = view;
  await step(async () =>
    all(container, 'button')
      .find((b) => b.title === 'Expand')
      .click(),
  );
  const closed = all(container, 'input[type="radio"]').find((r) =>
    /^Closed/.test(r.closest('label').textContent),
  );
  await step(async () => {
    closed.click();
    await settle();
  });
  return view;
};

afterEach(() => vi.clearAllMocks());

describe('closing a tagset', () => {
  it('names the values in use that are not in the list, and writes nothing', async () => {
    const client = makeClient({
      count: 12,
      valueCount: 3,
      values: [
        { value: 'NOUN', parts: ['NOUN'], count: 9 },
        { value: 'X', parts: ['X'], count: 2 },
      ],
    });
    const view = await close(client);
    expect(client.asked).toEqual([
      [
        'sl-pos',
        { type: 'value-set', values: ['N', 'V'], delimiters: '', parts: 'all' },
        { limit: 5 },
      ],
    ]);
    expect(client.writes).toEqual([]);
    const notice = view.container.querySelector('[data-testid="tagset-refused"]');
    expect(notice?.textContent).toBe(
      'Not saved. These values are in use and not in the list:POS: 12 annotations, NOUN (9), X (2), and 1 more',
    );
    expect(notifyError).not.toHaveBeenCalled();
    // The list reads as it was.
    const open = all(view.container, 'input[type="radio"]').find((r) =>
      /^Open/.test(r.closest('label').textContent),
    );
    expect(open.checked).toBe(true);
    await view.unmount();
  });

  it('saves a close nothing breaks, with its rule', async () => {
    const client = makeClient({ count: 0, valueCount: 0, values: [] });
    const view = await close(client);
    expect(client.writes.map((w) => w[0])).toEqual(['setConfig', 'setConstraints']);
    expect(client.writes[1][2]).toContainEqual({
      type: 'value-set',
      values: ['N', 'V'],
      delimiters: '',
      parts: 'all',
    });
    expect(view.container.querySelector('[data-testid="tagset-refused"]')).toBeNull();
    await view.unmount();
  });
});
