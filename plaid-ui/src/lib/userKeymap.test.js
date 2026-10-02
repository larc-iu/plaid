import { describe, it, expect } from 'vitest';
import { configureUi } from './uiConfig.js';
import { KeymapConflict, loadUserKeymap, saveUserKeymap } from './userKeymap.js';
import { createKeymap } from './keymap.js';

configureUi({ configNamespace: 'plaid' });

// A client whose user data is the given entries, and which fails any get: a
// get of a key never saved is a 404 the browser logs on every page load.
const clientWith = (entries) => ({
  userData: {
    get: () => {
      throw new Error('read by listing, not by get');
    },
    listPage: async (userId, { prefix }) => ({
      entries: entries.filter((e) => e.key.startsWith(prefix)),
      nextCursor: null,
    }),
  },
});

describe('loadUserKeymap', () => {
  it('reads the overrides saved under this app', async () => {
    const client = clientWith([
      { key: 'plaid:keymap', value: { metadata: { 'node.child': 'KeyN' } } },
      { key: 'plaid:keymapOld', value: { metadata: { 'node.child': 'KeyX' } } },
    ]);
    expect(await loadUserKeymap(client, 'a@b.com')).toEqual({ 'node.child': 'KeyN' });
  });

  it('is empty for a person who never saved one', async () => {
    expect(await loadUserKeymap(clientWith([]), 'a@b.com')).toEqual({});
  });
});

// A client that holds one map, so a save can be read back.
const accountWith = (initial) => {
  const state = { map: initial ? { ...initial } : null, puts: 0, deletes: 0 };
  return {
    state,
    client: {
      userData: {
        get: () => {
          throw new Error('read by listing, not by get');
        },
        listPage: async () => ({
          entries: state.map ? [{ key: 'plaid:keymap', value: { metadata: state.map } }] : [],
          nextCursor: null,
        }),
        put: async (userId, key, value) => {
          state.map = { ...value.metadata };
          state.puts += 1;
        },
        delete: async () => {
          state.map = null;
          state.deletes += 1;
        },
      },
    },
  };
};

describe('saveUserKeymap', () => {
  it('writes the actions that changed, over what the account holds', async () => {
    const { client, state } = accountWith({ 'node.child': ['KeyN'] });
    // A screen that has not read that binding saves one of its own.
    const stored = await saveUserKeymap(client, 'a@b.com', {
      before: {},
      next: { 'morph.zero': ['Alt+0'] },
    });
    expect(stored).toEqual({ 'node.child': ['KeyN'], 'morph.zero': ['Alt+0'] });
    expect(state.map).toEqual(stored);
  });

  it('removes a binding the screen reset, and leaves the rest', async () => {
    const { client, state } = accountWith({ 'node.child': ['KeyN'], 'morph.zero': ['Alt+0'] });
    const stored = await saveUserKeymap(client, 'a@b.com', {
      before: { 'node.child': ['KeyN'] },
      next: {},
    });
    expect(stored).toEqual({ 'morph.zero': ['Alt+0'] });
    expect(state.map).toEqual(stored);
  });

  it('replaces the whole map for Reset all, and stores nothing when it is empty', async () => {
    const { client, state } = accountWith({ 'node.child': ['KeyN'] });
    expect(
      await saveUserKeymap(client, 'a@b.com', { before: {}, next: {}, replace: true }),
    ).toEqual({});
    expect(state.map).toBe(null);
    expect(state.deletes).toBe(1);
  });
});

// Two tabs of one person, neither reloaded, each bind a different action to
// one chord. Each tab's own check passed, since each found the chord free,
// and the merge stored both: after a reload Ctrl+J answered to both
// (H24-SETTINGS-2). The merged map is checked before it is written.
describe('saveUserKeymap, two tabs', () => {
  const ACTIONS = [
    { id: 'grid.accept', scope: 'grid', group: 'g', label: 'Accept', keys: ['Mod+Enter'] },
    { id: 'grid.discard', scope: 'grid', group: 'g', label: 'Discard', keys: ['Mod+Backspace'] },
    { id: 'pop.create', scope: 'pop', group: 'p', label: 'Create', keys: ['Mod+Enter'] },
  ];

  it('refuses a chord another tab bound since, naming the action, and writes nothing', async () => {
    const { client, state } = accountWith(null);
    const tabA = createKeymap(ACTIONS);
    const tabB = createKeymap(ACTIONS);
    const bind = (tab, id, chord) => {
      expect(tab.check(id, chord)).toBeNull();
      return saveUserKeymap(client, 'a@b.com', {
        before: tab.overrides(),
        next: tab.withBinding(id, chord),
        keymap: tab,
      });
    };
    await bind(tabA, 'grid.accept', 'Mod+j');
    const refused = await bind(tabB, 'grid.discard', 'Mod+j').catch((e) => e);
    expect(refused).toBeInstanceOf(KeymapConflict);
    expect(refused.found.with.label).toBe('Accept');
    expect(refused.chord).toBe('Mod+j');
    expect(refused.stored).toEqual({ 'grid.accept': ['Mod+j'] });
    expect(state.map).toEqual({ 'grid.accept': ['Mod+j'] });
    expect(state.puts).toBe(1);
  });

  it('lets an action in another scope take the same chord', async () => {
    const { client } = accountWith({ 'grid.accept': ['Mod+j'] });
    const tab = createKeymap(ACTIONS);
    const stored = await saveUserKeymap(client, 'a@b.com', {
      before: {},
      next: { 'pop.create': ['Mod+j'] },
      keymap: tab,
    });
    expect(stored).toEqual({ 'grid.accept': ['Mod+j'], 'pop.create': ['Mod+j'] });
  });

  it("sends whoever took a default back to theirs when a reset needs it, as one tab's reset does", async () => {
    // Another tab moved Discard onto Accept's default after this one moved
    // Accept away. This tab now resets Accept.
    const { client } = accountWith({
      'grid.accept': ['Mod+j'],
      'grid.discard': ['Mod+Enter'],
    });
    const tab = createKeymap(ACTIONS);
    tab.setOverrides({ 'grid.accept': ['Mod+j'] });
    const stored = await saveUserKeymap(client, 'a@b.com', {
      before: tab.overrides(),
      next: tab.withBinding('grid.accept', null),
      keymap: tab,
    });
    expect(stored).toEqual({});
  });
});
