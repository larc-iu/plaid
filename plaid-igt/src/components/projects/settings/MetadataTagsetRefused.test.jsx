import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { TagsetsSettings } from './TagsetsSettings.jsx';
import { DocumentMetadataSettings } from './DocumentMetadataSettings.jsx';
import { notifyError } from '@/utils/feedback';

// A closed list over a document metadata field whose documents hold values not
// in it (H2-12-3). Closing the tagset, or pointing the field at a closed one,
// was saved with no word, though the guide says neither is saved while the
// field holds values outside the list, and the Not saved notice names them.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
}));

// The metadata table, with its save and error handlers in reach.
const manager = vi.hoisted(() => ({ props: null }));
vi.mock('./DocumentMetadataManager.jsx', () => ({
  DocumentMetadataManager: (props) => {
    manager.props = props;
    return null;
  },
}));

afterEach(() => vi.clearAllMocks());

const DIALECTS = (mode) => ({ mode, delimiters: '', values: [{ value: 'Inland' }] });

const project = ({ mode = 'suggest', assigned = true } = {}) => ({
  id: 'p-1',
  textLayers: [],
  config: {
    igt: {
      tagsets: { Dialects: DIALECTS(mode) },
      documentMetadata: [{ name: 'Dialect', ...(assigned ? { tagset: 'Dialects' } : {}) }],
    },
  },
});

// A core whose one document holds Dialect 'Coastal'.
const makeClient = (options) => {
  const client = {
    writes: [],
    queries: [],
    query: async (q) => {
      client.queries.push(q);
      return { results: [['Coastal', 1]] };
    },
    projects: {
      get: async () => project(options),
      setConfig: async (_id, _ns, key, value) => client.writes.push([key, value]),
    },
    spanLayers: {},
    withOperation: async (_m, fn) => fn(),
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

describe('a closed list over a document metadata field', () => {
  it('closing the tagset names the value a document holds, and writes nothing', async () => {
    const client = makeClient({ mode: 'suggest' });
    const view = await renderComponent(
      <TagsetsSettings
        project={project({ mode: 'suggest' })}
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
    expect(client.writes).toEqual([]);
    expect(container.querySelector('[data-testid="tagset-refused"]')?.textContent).toBe(
      'Not saved. These values are in use and not in the list:Dialect: 1 document, Coastal (1)',
    );
    await view.unmount();
  });

  it('pointing the field at a closed tagset names the value, and writes nothing', async () => {
    const client = makeClient({ mode: 'closed', assigned: false });
    const view = await renderComponent(
      <DocumentMetadataSettings
        project={project({ mode: 'closed', assigned: false })}
        projectId="p-1"
        client={client}
        tagsetNames={['Dialects']}
        onProjectUpdate={async () => {}}
      />,
    );
    let error;
    await view.step(async () => {
      await manager.props
        .onSaveChanges({ enabledFields: [{ name: 'Dialect', tagset: 'Dialects', enabled: true }] })
        .catch((e) => (error = e));
      manager.props.onError(error);
    });
    expect(client.writes).toEqual([]);
    expect(notifyError).toHaveBeenCalledWith(
      'These values are in use and not in the list: Dialect: 1 document, Coastal (1).',
      'Not saved',
    );
    expect(view.container.textContent).not.toContain('Failed to load or save');
    await view.unmount();
  });

  it('pointing the field at an open tagset is saved', async () => {
    const client = makeClient({ mode: 'suggest', assigned: false });
    const view = await renderComponent(
      <DocumentMetadataSettings
        project={project({ mode: 'suggest', assigned: false })}
        projectId="p-1"
        client={client}
        tagsetNames={['Dialects']}
        onProjectUpdate={async () => {}}
      />,
    );
    await view.step(() =>
      manager.props.onSaveChanges({
        enabledFields: [{ name: 'Dialect', tagset: 'Dialects', enabled: true }],
      }),
    );
    expect(client.queries).toEqual([]);
    expect(client.writes.map(([key]) => key)).toContain('documentMetadata');
    await view.unmount();
  });
});
