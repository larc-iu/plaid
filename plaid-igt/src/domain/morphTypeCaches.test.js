import { describe, it, expect } from 'vitest';
import {
  cacheProjectIds,
  entryTypeTargets,
  mergeTargets,
  planMorphTypeCaches,
  retypedRoots,
  revertedCaches,
  sendMorphTypeCaches,
} from './morphTypeCaches.js';

const items = [
  { id: 'h', form: 'kai', metadata: { morphType: 'suffix' } },
  { id: 's1', form: 'kai', metadata: { parent: 'h' } },
  { id: 's2', form: 'kai', metadata: { parent: 'h', morphType: 'enclitic' } },
  { id: 'x', form: 'ta' },
];

describe('entryTypeTargets', () => {
  it('reaches the senses below, each with the type it goes by, and skips an entry with none', () => {
    expect(entryTypeTargets(items, ['h', 'x'])).toEqual(
      new Map([
        ['h', 'suffix'],
        ['s1', 'suffix'],
        ['s2', 'enclitic'],
      ]),
    );
  });
});

describe('retypedRoots', () => {
  it('names an entry whose own type or headword changed, and no other', () => {
    const after = items.map((it) =>
      it.id === 'h'
        ? { ...it, metadata: { morphType: 'prefix' } }
        : it.id === 'x'
          ? { ...it, metadata: { parent: 'h' } }
          : it.id === 's1'
            ? { ...it, metadata: { parent: 'h', gloss: 'new' } }
            : it,
    );
    expect(retypedRoots(items, after)).toEqual(['h', 'x']);
  });
});

describe('mergeTargets', () => {
  it("gives the loser's morphemes the survivor's type, and a sense moved under it the type it goes by there", () => {
    const lex = [
      { id: 'a', form: 'kai', metadata: { morphType: 'stem' } },
      { id: 'b', form: 'kai', metadata: { morphType: 'suffix' } },
      { id: 'bs', form: 'kai', metadata: { parent: 'b' } },
    ];
    const refPlans = [{ id: 'bs', metadata: { parent: 'a' } }];
    expect(mergeTargets(lex, refPlans, 'a', ['b'])).toEqual(
      new Map([
        ['a', 'stem'],
        ['bs', 'stem'],
        ['b', 'stem'],
      ]),
    );
  });
});

describe('planning and sending', () => {
  it('reads the projects the user writes that use the vocabulary, and writes only what differs, per project', async () => {
    const queries = [];
    const client = {
      projects: {
        list: async () => [
          { id: 'p1', vocabs: [{ id: 'v1' }], writers: ['me'] },
          { id: 'p2', vocabs: [{ id: 'v1' }], readers: ['me'] },
          { id: 'p3', vocabs: [{ id: 'v2' }], writers: ['me'] },
          { id: 'p4', vocabs: [{ id: 'v1' }], maintainers: ['me'] },
        ],
      },
      query: async (q) => {
        queries.push(q);
        const rows = {
          p1: [
            ['m1', 'h', 'stem', 1],
            ['m2', 's1', 'suffix', 1],
          ],
          p4: [['m3', 's2', null, 1]],
        };
        return { results: rows[q.scope.projectIds[0]] ?? [] };
      },
    };
    const projects = await cacheProjectIds(client, { id: 'me' }, 'v1');
    expect(projects).toEqual(['p1', 'p4']);
    const plans = await planMorphTypeCaches(client, projects, entryTypeTargets(items, ['h']));
    expect(queries[0].where[0]).toEqual(['link', '?l', { item: ['h', 's1', 's2'] }]);
    expect(plans).toEqual([
      { projectId: 'p1', morphemeId: 'm1', morphType: 'suffix', was: 'stem' },
      { projectId: 'p4', morphemeId: 'm3', morphType: 'enclitic', was: null },
    ]);
    const sent = [];
    await sendMorphTypeCaches({ tokens: { bulkUpdate: async (u) => sent.push(u) } }, plans);
    expect(sent).toEqual([
      [{ id: 'm1', metadata: [{ op: 'set', path: ['morphType'], value: 'suffix' }] }],
      [{ id: 'm3', metadata: [{ op: 'set', path: ['morphType'], value: 'enclitic' }] }],
    ]);
  });
});

describe('revertedCaches', () => {
  it('puts back what each plan held, taking away a cache that was not there', async () => {
    const sent = [];
    await sendMorphTypeCaches(
      { tokens: { bulkUpdate: async (u) => sent.push(u) } },
      revertedCaches([
        { projectId: 'p1', morphemeId: 'm1', morphType: 'suffix', was: 'stem' },
        { projectId: 'p1', morphemeId: 'm2', morphType: 'suffix', was: null },
      ]),
    );
    expect(sent).toEqual([
      [
        { id: 'm1', metadata: [{ op: 'set', path: ['morphType'], value: 'stem' }] },
        { id: 'm2', metadata: [{ op: 'delete', path: ['morphType'] }] },
      ],
    ]);
  });
});
