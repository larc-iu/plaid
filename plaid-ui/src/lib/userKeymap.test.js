import { describe, it, expect } from 'vitest';
import { configureUi } from './uiConfig.js';
import { loadUserKeymap, saveUserKeymap } from './userKeymap.js';

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
