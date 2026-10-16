import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { TagsetsSettings } from './TagsetsSettings.jsx';

// The project's tagset rename (REV5-WIRE-2): the tagsets and every field that
// names the renamed tagset go in one batch, so no read sees a field naming a
// tagset that is gone, and a refused repoint refuses the rename with it.

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
  it('refuses the rename with its fields, in one batch', async () => {
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
        get: async () => structuredClone(server),
        setConfig: async (_id, _ns, key, value) => {
          if (key === 'documentMetadata') throw new Error('refused');
          server.config.igt[key] = value;
        },
      },
      spanLayers: { setConfig: async () => {}, setConstraints: async () => {} },
      // A batch lands whole or not at all.
      batches: 0,
      async batched(fn) {
        this.batches += 1;
        const saved = structuredClone(server.config);
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
        try {
          for (const op of ops) await op();
        } catch (e) {
          server.config = saved;
          throw e;
        }
        return [];
      },
    };
    let project = structuredClone(server);
    const onProjectUpdate = vi.fn(async () => {
      project = structuredClone(server);
    });
    const { step, unmount } = await renderComponent(
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
    expect(threw).toBe(true);
    expect(client.batches).toBe(1);
    expect(Object.keys(server.config.igt.tagsets)).toEqual(['cases']);
    expect(server.config.igt.documentMetadata).toEqual([{ name: 'case', tagset: 'cases' }]);
    await unmount();
  });

  it('still refuses when the rename itself is refused', async () => {
    const client = {
      projects: {
        get: async () => structuredClone(project),
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

// REV3-WIRE-4: another maintainer pointed a second field at the tagset after
// this page was read. The rename repoints both and answers how many.
describe('a rename from a page read before a field was pointed at the tagset', () => {
  it('repoints every field the save reads and answers their number', async () => {
    const leipzig = { delimiters: '.', mode: 'suggest', values: [{ value: 'PL' }] };
    const field = (id, name) => ({
      id,
      name,
      config: { igt: { scope: 'Morpheme', tagset: 'Leipzig' } },
      constraints: { igt: [{ type: 'single-span' }] },
    });
    const withFields = (fields) => ({
      id: 'p-1',
      config: { igt: { tagsets: { Leipzig: leipzig } } },
      textLayers: [
        {
          id: 'tl',
          config: { plaid: { role: 'baseline' } },
          tokenLayers: [{ id: 'ml', config: { plaid: { role: 'morpheme' } }, spanLayers: fields }],
        },
      ],
    });
    const server = withFields([field('a', 'Gloss'), field('b', 'Lex Gloss')]);
    const repointed = [];
    let inBatch = false;
    const client = {
      projects: { get: async () => structuredClone(server), setConfig: async () => {} },
      spanLayers: {
        setConfig: async (id, _ns, key, value) => repointed.push([id, key, value, inBatch]),
        setConstraints: async () => {},
        refusedValues: async () => ({ count: 0, valueCount: 0, values: [] }),
        checkConstraints: async () => ({ violations: [], violationCount: 0 }),
      },
      withOperation: async (_m, fn) => fn(),
      async batched(fn) {
        inBatch = true;
        fn({ projects: this.projects, spanLayers: this.spanLayers });
        inBatch = false;
        return [];
      },
    };
    const { step, unmount } = await renderComponent(
      <TagsetsSettings
        project={withFields([field('a', 'Gloss')])}
        projectId="p-1"
        client={client}
        onProjectUpdate={async () => {}}
      />,
    );
    let answer;
    await step(async () => {
      answer = await tagsetsManager.props.onSaveChanges(
        { LGR: leipzig },
        { renamed: { from: 'Leipzig', to: 'LGR' } },
      );
    });
    expect(repointed).toEqual([
      ['a', 'tagset', 'LGR', true],
      ['b', 'tagset', 'LGR', true],
    ]);
    expect(answer).toEqual({ repointed: 2 });
    await unmount();
  });
});

// REV3-WIRE-3: another maintainer points Gloss at Leipzig after this save
// read the project and before its batch lands. Gloss is declared with the
// old list by theirs, and this save's own batch does not know Gloss. The
// rules are put in force from a read after the save, so Gloss takes the new
// list.
describe('a field pointed at the tagset while the save is on its way', () => {
  it('takes the list the save wrote', async () => {
    const vs = (values) => ({ type: 'value-set', values, delimiters: '.', parts: 'all' });
    const tagsets = (values) => ({
      Leipzig: { delimiters: '.', mode: 'closed', values: values.map((value) => ({ value })) },
    });
    const layer = (id, name, tagset, constraints) => ({
      id,
      name,
      config: { igt: { scope: 'Morpheme', ...(tagset ? { tagset } : {}) } },
      constraints: { igt: constraints },
    });
    const server = {
      id: 'p-1',
      config: { igt: { tagsets: tagsets(['PL']) } },
      textLayers: [
        {
          id: 'tl',
          config: { plaid: { role: 'baseline' } },
          tokenLayers: [
            {
              id: 'ml',
              config: { plaid: { role: 'morpheme' } },
              spanLayers: [
                layer('mg', 'Morph Gloss', 'Leipzig', [{ type: 'single-span' }, vs(['PL'])]),
                layer('g', 'Gloss', null, [{ type: 'single-span' }]),
              ],
            },
          ],
        },
      ],
    };
    const spans = () => server.textLayers[0].tokenLayers[0].spanLayers;
    const page = structuredClone(server);
    const client = {
      projects: {
        get: async () => structuredClone(server),
        setConfig: async (_id, _ns, key, value) => {
          server.config.igt[key] = value;
        },
      },
      spanLayers: {
        setConstraints: async (id, ns, list, _d, options) => {
          const sl = spans().find((x) => x.id === id);
          if (JSON.stringify(options?.expected) !== JSON.stringify(sl.constraints[ns])) {
            throw Object.assign(new Error('HTTP 409'), { status: 409 });
          }
          sl.constraints = { [ns]: list };
        },
        checkConstraints: async () => ({ violations: [], violationCount: 0 }),
        refusedValues: async () => ({ count: 0, valueCount: 0, values: [] }),
        get: async (id) => structuredClone(spans().find((x) => x.id === id)),
      },
      withOperation: async (_m, fn) => fn(),
      async batched(fn) {
        // The other maintainer's save lands first: Gloss on Leipzig, with
        // the list as they read it.
        const g = spans().find((x) => x.id === 'g');
        g.config.igt.tagset = 'Leipzig';
        g.constraints = { igt: [{ type: 'single-span' }, vs(['PL'])] };
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
        fn({ projects: queue('projects'), spanLayers: queue('spanLayers') });
        for (const op of ops) await op();
        return [];
      },
    };
    const { step, unmount } = await renderComponent(
      <TagsetsSettings
        project={page}
        projectId="p-1"
        client={client}
        onProjectUpdate={async () => {}}
      />,
    );
    await step(async () => {
      await tagsetsManager.props.onSaveChanges(tagsets(['PL', 'NEW']));
    });
    for (const id of ['mg', 'g']) {
      expect(spans().find((x) => x.id === id).constraints.igt).toEqual([
        { type: 'single-span' },
        vs(['PL', 'NEW']),
      ]);
    }
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
