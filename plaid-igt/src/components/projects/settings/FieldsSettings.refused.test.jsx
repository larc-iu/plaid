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
