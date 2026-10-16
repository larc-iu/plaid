import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { TagsetsSettings } from './TagsetsSettings.jsx';
import { TagsetsManager } from './TagsetsManager.jsx';
import { notifyError, notifySuccess } from '@/utils/feedback';

// Closing a list the stored values break: the server is asked first which
// values it would refuse, and the tagset's panel names them, with nothing
// written. A close nothing breaks is saved with its rule.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

// `bare`: a second field, Gloss, governed by a closed Leipzig whose layer
// holds no list (rules removed by another client, or a project made before
// lists were declared), with values off it. `pointed`: a second field, Gloss,
// that another maintainer has pointed at POS.
const project = ({ bare = false, pointed = false } = {}) => ({
  id: 'p-1',
  config: {
    igt: {
      tagsets: {
        POS: { mode: 'suggest', delimiters: '', values: [{ value: 'N' }, { value: 'V' }] },
        ...(bare
          ? { Leipzig: { mode: 'closed', delimiters: '.', values: [{ value: 'NOM' }] } }
          : {}),
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
            ...(bare
              ? [
                  {
                    id: 'sl-gloss',
                    name: 'Gloss',
                    config: { igt: { scope: 'Word', tagset: 'Leipzig' } },
                    constraints: {},
                  },
                ]
              : []),
            ...(pointed
              ? [
                  {
                    id: 'sl-gloss',
                    name: 'Gloss',
                    config: { igt: { scope: 'Word', tagset: 'POS' } },
                    constraints: { igt: [{ type: 'single-span' }] },
                  },
                ]
              : []),
          ],
        },
      ],
    },
  ],
});

// `options` is the project the server holds, as `project` takes them.
const makeClient = (answer, answers = {}, options = {}) => {
  const client = {
    asked: [],
    writes: [],
    projects: {
      get: async () => project(options),
      setConfig: async (_id, _ns, key, value) => client.writes.push(['setConfig', key, value]),
    },
    spanLayers: {
      setConfig: async () => {},
      setConstraints: async (id, ns, constraints) =>
        client.writes.push(['setConstraints', id, constraints]),
      refusedValues: async (id, rule, options) => {
        client.asked.push([id, rule, options]);
        return answers[id] ?? answer;
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

const typeInto = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const mount = (client, options) =>
  renderComponent(
    <TagsetsSettings
      project={project(options)}
      projectId="p-1"
      client={client}
      onProjectUpdate={async () => {}}
    />,
  );

const close = async (client, options) => {
  const view = await renderComponent(
    <TagsetsSettings
      project={project(options)}
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

describe('a field whose layer holds no list', () => {
  const glossRefused = {
    count: 2,
    valueCount: 1,
    values: [{ value: 'QQ', parts: ['QQ'], count: 2 }],
  };

  // REV-WIRE-1: Gloss's missing list blocked every other tagset save, and an
  // add or a rename said nothing.
  it('does not hold up adding a tagset', async () => {
    const client = makeClient(
      { count: 0, valueCount: 0, values: [] },
      { 'sl-gloss': glossRefused },
      { bare: true },
    );
    const view = await mount(client, { bare: true });
    const input = all(view.container, 'input').find((i) => /New tagset name/.test(i.placeholder));
    await view.step(async () => typeInto(input, 'Genre'));
    await view.step(async () => {
      all(view.container, 'button')
        .find((b) => /Add tagset/.test(b.textContent))
        .click();
      await settle();
    });
    expect(client.asked).toEqual([]);
    expect(client.writes.map((w) => w[0])).toEqual(['setConfig']);
    expect(Object.keys(client.writes[0][2])).toEqual(['POS', 'Leipzig', 'Genre']);
    expect(notifySuccess).toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('does not hold up closing another tagset, and is not asked about', async () => {
    const client = makeClient(
      { count: 0, valueCount: 0, values: [] },
      { 'sl-gloss': glossRefused },
      { bare: true },
    );
    const view = await close(client, { bare: true });
    expect(client.asked.map((a) => a[0])).toEqual(['sl-pos']);
    expect(client.writes.map((w) => w[0])).toEqual(['setConfig', 'setConstraints']);
    expect(client.writes[1][1]).toBe('sl-pos');
    expect(view.container.querySelector('[data-testid="tagset-refused"]')).toBeNull();
    await view.unmount();
  });
});

// REV2-WIRE-2: a page read before another maintainer pointed Gloss at POS.
// Closing POS puts the list on Gloss too, and asks about Gloss's values.
describe('a field pointed at the tagset since the page was read', () => {
  it('is asked about and takes the list', async () => {
    const client = makeClient({ count: 0, valueCount: 0, values: [] }, {}, { pointed: true });
    const view = await close(client);
    expect(client.asked.map((a) => a[0])).toEqual(['sl-pos', 'sl-gloss']);
    const declared = client.writes.filter((w) => w[0] === 'setConstraints');
    expect(declared.map((w) => w[1])).toEqual(['sl-pos', 'sl-gloss']);
    expect(declared[1][2]).toContainEqual({
      type: 'value-set',
      values: ['N', 'V'],
      delimiters: '',
      parts: 'all',
    });
    await view.unmount();
  });

  it("stops the close when that field's values break the list", async () => {
    const client = makeClient(
      { count: 0, valueCount: 0, values: [] },
      {
        'sl-gloss': { count: 1, valueCount: 1, values: [{ value: 'QQ', parts: ['QQ'], count: 1 }] },
      },
      { pointed: true },
    );
    const view = await close(client);
    expect(client.writes).toEqual([]);
    const notice = view.container.querySelector('[data-testid="tagset-refused"]');
    expect(notice?.textContent).toBe(
      'Not saved. These values are in use and not in the list:Gloss: 1 annotation, QQ (1)',
    );
    await view.unmount();
  });
});

describe('a refused composite value', () => {
  // REV-WIRE-3: the part not in the list is named, not only the whole value.
  it('names the parts not in the list', async () => {
    const client = makeClient({
      count: 3,
      valueCount: 2,
      values: [
        { value: 'N.X', parts: ['X'], count: 2 },
        { value: 'Q', parts: ['Q'], count: 1 },
      ],
    });
    const view = await close(client);
    const notice = view.container.querySelector('[data-testid="tagset-refused"]');
    expect(notice?.textContent).toBe(
      'Not saved. These values are in use and not in the list:POS: 3 annotations, N.X (2, X not listed), Q (1)',
    );
    await view.unmount();
  });
});

describe('a refusal of a change made outside a tagset panel', () => {
  // An add, a rename or a delete has no panel to show the values in, so a
  // toast names them.
  it('is a toast naming the values', async () => {
    const refusedValues = [
      {
        layerId: 'sl-gloss',
        field: 'Gloss',
        count: 2,
        valueCount: 1,
        values: [{ value: '1SG.NOM', parts: ['1SG'], count: 2 }],
      },
    ];
    const onSaveChanges = vi.fn(async () => {
      throw Object.assign(new Error('Values in use are not in the list'), { refusedValues });
    });
    const view = await renderComponent(
      <TagsetsManager
        tagsets={{ POS: { mode: 'suggest', delimiters: '', values: [] } }}
        usage={{}}
        onSaveChanges={onSaveChanges}
        onLoadAttested={async () => []}
      />,
    );
    const input = all(view.container, 'input').find((i) => /New tagset name/.test(i.placeholder));
    await view.step(async () => typeInto(input, 'Genre'));
    await view.step(async () => {
      all(view.container, 'button')
        .find((b) => /Add tagset/.test(b.textContent))
        .click();
      await settle();
    });
    expect(onSaveChanges).toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      'These values are in use and not in the list: Gloss: 2 annotations, 1SG.NOM (2, 1SG not listed).',
      'Not saved',
    );
    expect(notifySuccess).not.toHaveBeenCalled();
    await view.unmount();
  });
});
