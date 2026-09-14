import { describe, it, expect } from 'vitest';
import { metaGlob, projectOfKey, readMetas } from './jobs.js';

// The conversation list, read from the user's own key/value store. Two things
// are worth pinning: the project comes out of the KEY (a sidebar entry has
// never carried one, so anything else would lose every older conversation),
// and widening to every project must not drag the transcripts down with it.

const store = (list) => ({
  client: {
    userData: {
      // `list` is the client's all-pages read. `listPage` is here to be left
      // alone: the store pages by key and the sidebar orders by recency, so
      // one page would be an arbitrary hundred rather than the newest hundred.
      list: async (_u, opts) => list(opts),
      listPage: async () => {
        throw new Error('readMetas must read every page, not one');
      },
    },
  },
  userId: 'a@b.com',
  app: 'igt',
  projectId: 'p1',
});

const entry = (project, id, updatedAt) => ({
  key: `igt:assistant:${project}:meta:${id}`,
  value: { id, title: id, updatedAt },
});

describe('projectOfKey', () => {
  it('reads the project out of the middle of the key', () => {
    expect(projectOfKey('igt', 'igt:assistant:p1:meta:c1')).toBe('p1');
    expect(projectOfKey('igt', 'igt:assistant:p1:conv:c1')).toBe('p1');
  });

  it('is null for a key of another app or another shape', () => {
    // A ud: record read by the igt panel would be a conversation its service
    // cannot find, so it must not be silently attributed to a project here.
    expect(projectOfKey('igt', 'ud:assistant:p1:meta:c1')).toBeNull();
    expect(projectOfKey('igt', 'igt:assistant:')).toBeNull();
    expect(projectOfKey('igt', 'something else')).toBeNull();
    expect(projectOfKey('igt', undefined)).toBeNull();
  });
});

describe('metaGlob', () => {
  it('selects the sidebar entries and not the transcripts beside them', () => {
    // The whole reason the glob exists: `igt:assistant:` as a prefix matches
    // both, and a transcript runs to hundreds of kilobytes.
    const glob = metaGlob('igt');
    expect(glob).toBe('igt:assistant:*:meta:*');
    expect(glob).not.toContain('conv');
  });
});

describe('readMetas', () => {
  it('narrows by prefix to this project by default', async () => {
    let seen = null;
    const metas = await readMetas(
      store((opts) => {
        seen = opts;
        return [entry('p1', 'c1', '2024-01-01')];
      }),
    );
    expect(seen.prefix).toBe('igt:assistant:p1:meta:');
    expect(seen.pattern).toBeUndefined();
    expect(metas.map((m) => m.id)).toEqual(['c1']);
  });

  it('uses the glob for every project, and tags each row with its own', async () => {
    let seen = null;
    const metas = await readMetas(
      store((opts) => {
        seen = opts;
        return [entry('p1', 'c1', '2024-01-01'), entry('p2', 'c2', '2024-06-01')];
      }),
      { allProjects: true },
    );
    expect(seen.pattern).toBe('igt:assistant:*:meta:*');
    expect(seen.prefix).toBeUndefined();
    expect(metas.map((m) => [m.id, m.projectId])).toEqual([
      ['c2', 'p2'],
      ['c1', 'p1'],
    ]);
  });

  it('sorts newest first, so the panel resuming the top one resumes the latest', async () => {
    const metas = await readMetas(
      store(() => [
        entry('p1', 'old', '2020-01-01'),
        entry('p1', 'new', '2030-01-01'),
        entry('p1', 'mid', '2025-01-01'),
      ]),
    );
    expect(metas.map((m) => m.id)).toEqual(['new', 'mid', 'old']);
  });

  it('drops an entry with no id rather than listing a row that cannot open', async () => {
    const metas = await readMetas(
      store(() => [
        { key: 'igt:assistant:p1:meta:x', value: null },
        entry('p1', 'c1', '2024-01-01'),
      ]),
    );
    expect(metas.map((m) => m.id)).toEqual(['c1']);
  });

  it('reads nothing without a user, since the store is theirs', async () => {
    expect(await readMetas({ ...store(() => []), userId: null })).toEqual([]);
  });

  it('reads the whole listing rather than one page', async () => {
    // Three hundred conversations is three requests at the client's default
    // bound. Taking only the first would drop two thirds of the sidebar, and
    // the rows that survived would not be the newest ones.
    const many = Array.from({ length: 300 }, (_, i) =>
      entry('p1', `c${i}`, `2026-01-${String((i % 28) + 1).padStart(2, '0')}`),
    );
    const metas = await readMetas(store(() => many));
    expect(metas).toHaveLength(300);
  });
});
