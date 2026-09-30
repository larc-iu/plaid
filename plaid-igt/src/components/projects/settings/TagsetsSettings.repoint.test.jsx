import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { TagsetsSettings } from './TagsetsSettings.jsx';

// The project's tagset rename, when the rename lands and repointing the fields
// that name it is refused. The vocabulary screen keeps the same contract
// (VocabularyDetail.writes.test.jsx).

const tagsetsManager = vi.hoisted(() => ({ props: null }));
vi.mock('./TagsetsManager.jsx', () => ({
  TagsetsManager: (props) => {
    tagsetsManager.props = props;
    return null;
  },
}));
vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

describe('the project tagsets section', () => {
  it('keeps a rename that landed when the fields that name it are refused', async () => {
    const cases = { mode: 'closed', tags: [{ value: 'NOM' }] };
    const server = {
      id: 'p-1',
      textLayers: [],
      config: {
        igt: {
          tagsets: { cases },
          documentMetadata: [{ name: 'case', tagset: 'cases' }],
        },
      },
    };
    const client = {
      projects: {
        setConfig: async (_id, _ns, key, value) => {
          if (key === 'documentMetadata') throw new Error('refused');
          server.config.igt[key] = value;
        },
      },
      spanLayers: { setConfig: async () => {}, setConstraints: async () => {} },
      // A batch queues its writes and sends them in turn on submit, a refusal
      // refusing the batch.
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
    let project = structuredClone(server);
    const onProjectUpdate = vi.fn(async () => {
      project = structuredClone(server);
    });
    const { rerender, step, unmount } = await renderComponent(
      <TagsetsSettings
        project={project}
        projectId="p-1"
        client={client}
        onProjectUpdate={onProjectUpdate}
      />,
    );
    let threw = false;
    await step(async () => {
      try {
        await tagsetsManager.props.onSaveChanges(
          { case: cases },
          { renamed: { from: 'cases', to: 'case' } },
        );
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(false);
    expect(onProjectUpdate).toHaveBeenCalled();
    await rerender(
      <TagsetsSettings
        project={project}
        projectId="p-1"
        client={client}
        onProjectUpdate={onProjectUpdate}
      />,
    );
    expect(Object.keys(tagsetsManager.props.tagsets)).toEqual(['case']);
    await unmount();
  });

  it('still refuses when the rename itself is refused', async () => {
    const client = {
      projects: {
        setConfig: async () => {
          throw new Error('refused');
        },
      },
      spanLayers: { setConfig: async () => {}, setConstraints: async () => {} },
      // A batch queues its writes and sends them in turn on submit, a refusal
      // refusing the batch.
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
    const project = {
      id: 'p-1',
      textLayers: [],
      config: { igt: { tagsets: { cases: { mode: 'open', tags: [] } } } },
    };
    const { step, unmount } = await renderComponent(
      <TagsetsSettings
        project={project}
        projectId="p-1"
        client={client}
        onProjectUpdate={async () => {}}
      />,
    );
    let threw = false;
    await step(async () => {
      try {
        await tagsetsManager.props.onSaveChanges(
          { case: { mode: 'open', tags: [] } },
          { renamed: { from: 'cases', to: 'case' } },
        );
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(true);
    await unmount();
  });
});

describe('the values a seed reads', () => {
  it("carry a morpheme's morph type reading, merged across the fields that use the tagset", async () => {
    const leipzig = { delimiters: '.:', mode: 'suggest', values: [] };
    const project = {
      id: 'p-1',
      config: {
        igt: {
          tagsets: { Leipzig: leipzig },
          documentMetadata: [{ name: 'Tag', tagset: 'Leipzig' }],
        },
      },
      textLayers: [
        {
          id: 'tl-1',
          config: { plaid: { role: 'baseline' } },
          tokenLayers: [
            {
              id: 'ml-1',
              config: { plaid: { role: 'morpheme' } },
              spanLayers: [
                {
                  id: 'msl',
                  name: 'Gloss',
                  config: { igt: { scope: 'Morpheme', tagset: 'Leipzig' } },
                },
              ],
            },
          ],
        },
      ],
    };
    const client = {
      query: vi.fn(async (q) => ({
        results: q.scope
          ? [['sbj:3.pfv', 2]]
          : q.where.some((c) => c[0] === 'vocab-link')
            ? []
            : [
                ['sbj:3.pfv', 'suffix', 'ti', 4],
                ['sbj:3.pfv', 'stem', 'sa', 1],
              ],
      })),
    };
    const { unmount } = await renderComponent(
      <TagsetsSettings project={project} projectId="p-1" client={client} />,
    );
    const rows = await tagsetsManager.props.onLoadAttested('Leipzig');
    expect(rows).toEqual([
      ['sbj:3.pfv', 4, { bound: true, beside: [] }],
      ['sbj:3.pfv', 3, undefined],
    ]);
    await unmount();
  });
});
