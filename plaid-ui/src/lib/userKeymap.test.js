import { describe, it, expect } from 'vitest';
import { configureUi } from './uiConfig.js';
import { loadUserKeymap } from './userKeymap.js';

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
