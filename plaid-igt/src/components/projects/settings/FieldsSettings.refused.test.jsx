import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { notifyError } from '@/utils/feedback';

// Pointing a field at a closed tagset the stored values break: the server is
// asked first which values it would refuse, nothing is written, and the
// section names them, as the Tagsets section does.

const manager = vi.hoisted(() => ({ props: null }));
vi.mock('./FieldsManager', () => ({
  FieldsManager: (props) => {
    manager.props = props;
    return null;
  },
}));
vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const { FieldsSettings } = await import('./FieldsSettings.jsx');

const role = (r) => ({ plaid: { role: r } });
const project = () => ({
  id: 'p1',
  config: {
    igt: { tagsets: { POS: { mode: 'closed', delimiters: '', values: [{ value: 'N' }] } } },
  },
  textLayers: [
    {
      id: 'text',
      config: role('baseline'),
      tokenLayers: [
        { id: 'sent', config: role('sentence'), spanLayers: [] },
        {
          id: 'word',
          config: role('word'),
          spanLayers: [
            {
              id: 'pos',
              name: 'POS',
              config: { igt: { scope: 'Word' } },
              constraints: { igt: [{ type: 'single-span' }] },
            },
          ],
        },
        { id: 'morph', config: role('morpheme'), spanLayers: [] },
      ],
    },
  ],
});

const fakeClient = (answer) => {
  const client = {
    asked: [],
    batches: 0,
    projects: { get: async () => project() },
    spanLayers: {
      refusedValues: async (...a) => {
        client.asked.push(a);
        return answer;
      },
    },
    batched: async (fn) => {
      client.batches += 1;
      const sink = new Proxy({}, { get: () => new Proxy({}, { get: () => () => {} }) });
      fn(sink);
      return [];
    },
  };
  return client;
};

// The table before and after the user points POS at the closed list.
const pointAtPos = {
  fields: [{ name: 'POS', scope: 'Word', isCustom: false, tagset: 'POS', lang: null }],
  ignoredTokens: null,
  previous: {
    fields: [{ name: 'POS', scope: 'Word', isCustom: false, tagset: null, lang: null }],
    ignoredTokens: null,
  },
};

const save = async (client) => {
  const view = await renderComponent(
    <FieldsSettings project={project()} projectId="p1" client={client} onProjectUpdate={vi.fn()} />,
  );
  let error = null;
  await view.step(async () => {
    try {
      await manager.props.onSaveChanges(pointAtPos);
    } catch (e) {
      error = e;
      manager.props.onError(e);
    }
  });
  return { ...view, error };
};

afterEach(() => vi.clearAllMocks());

describe('Settings > Fields, a closed tagset assigned', () => {
  it('names the values in use that are not in the list, and writes nothing', async () => {
    const client = fakeClient({
      count: 4,
      valueCount: 2,
      values: [{ value: 'NOUN', parts: ['NOUN'], count: 3 }],
    });
    const { container, error, unmount } = await save(client);
    expect(error).not.toBeNull();
    expect(client.asked).toEqual([
      ['pos', { type: 'value-set', values: ['N'], delimiters: '', parts: 'all' }, { limit: 5 }],
    ]);
    expect(client.batches).toBe(0);
    expect(container.querySelector('[data-testid="tagset-refused"]')?.textContent).toBe(
      'Not saved. These values are in use and not in the list:POS: 4 annotations, NOUN (3), and 1 more',
    );
    expect(notifyError).not.toHaveBeenCalled();
    await unmount();
  });

  it('saves when nothing is in the way', async () => {
    const client = fakeClient({ count: 0, valueCount: 0, values: [] });
    const { container, error, unmount } = await save(client);
    expect(error).toBeNull();
    expect(client.batches).toBe(1);
    expect(container.querySelector('[data-testid="tagset-refused"]')).toBeNull();
    await unmount();
  });
});

// REV3-WIRE-3, the mirror: another maintainer adds a value to POS after this
// save read the project and before its batch lands. By Luke's ruling on
// REV6-WIRE-1 the save states the tagsets it read, so core refuses it whole
// and the screen says the tagsets changed elsewhere.
describe('Settings > Fields, the tagset changed while the save is on its way', () => {
  it('is refused whole and says the tagsets changed elsewhere', async () => {
    const server = project();
    const pos = () => server.textLayers[0].tokenLayers[1].spanLayers[0];
    const client = {
      projects: {
        get: async () => structuredClone(server),
        // Core's compare-and-set on the tagsets cell: a value already held
        // writes nothing.
        setConfig: async (_id, _ns, key, value, _d, options) => {
          const held = server.config.igt[key] ?? null;
          if (
            options &&
            JSON.stringify(options.expected ?? null) !== JSON.stringify(held) &&
            JSON.stringify(value) !== JSON.stringify(held)
          ) {
            throw Object.assign(new Error('HTTP 409'), { status: 409 });
          }
          server.config.igt[key] = value;
        },
      },
      spanLayers: {
        refusedValues: async () => ({ count: 0, valueCount: 0, values: [] }),
        checkConstraints: async () => ({ violations: [], violationCount: 0 }),
        setConfig: async (_id, _ns, key, value) => {
          pos().config.igt[key] = value;
        },
        setConstraints: async (_id, ns, list, _d, options) => {
          if (JSON.stringify(options?.expected ?? null) !== JSON.stringify(pos().constraints[ns])) {
            throw Object.assign(new Error('HTTP 409'), { status: 409 });
          }
          pos().constraints = { [ns]: list };
        },
        repairConstraints: async () => {},
        get: async () => structuredClone(pos()),
      },
      withOperation: async (_m, fn) => fn(),
      batched: async (fn) => {
        server.config.igt.tagsets.POS.values.push({ value: 'V' });
        const ops = [];
        const queue = (bundle) =>
          new Proxy(
            {},
            {
              get:
                (_, m) =>
                (...a) =>
                  ops.push(() => client[bundle][m](...a)),
            },
          );
        fn({
          projects: queue('projects'),
          spanLayers: queue('spanLayers'),
          tokenLayers: queue('tokenLayers'),
        });
        const saved = structuredClone(server);
        try {
          for (const op of ops) await op();
        } catch (e) {
          Object.assign(server, saved);
          throw e;
        }
        return [];
      },
    };
    const { error, unmount } = await save(client);
    expect(error?.message).toBe('Tagsets changed elsewhere. Reload and redo your change.');
    expect(notifyError).toHaveBeenCalledWith(error, 'Not saved');
    expect(pos().config.igt.tagset).toBeUndefined();
    expect(pos().constraints.igt).toEqual([{ type: 'single-span' }]);
    await unmount();
  });
});
