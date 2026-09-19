// One person's keyboard bindings, kept on their account so they follow them
// between machines. Unlike a sort order or a page size (useStickyState), which
// describe a screen, a binding describes a person: the hand that learned it.
//
// Stored as the keymap's override diff under one key per app. The map sits
// under `metadata` because its keys are action ids, and the client recases
// every other object key on the way out and back (see `userData.put`).

import { configNamespace } from './uiConfig.js';

const keymapDataKey = () => `${configNamespace()}:keymap`;

/**
 * The person's overrides, or {} when they have none. Read as a listing: most
 * people never save a binding, and a get of a key never saved is a 404, which
 * the browser logs as an error on every page load. A listing of none is an
 * empty page.
 */
export async function loadUserKeymap(client, userId) {
  const key = keymapDataKey();
  const { entries } = await client.userData.listPage(userId, {
    prefix: key,
    includeValues: true,
    limit: 10,
  });
  const map = entries.find((e) => e.key === key)?.value?.metadata;
  return map && typeof map === 'object' ? map : {};
}

/** Replace them. Nothing changed is nothing stored. */
export async function saveUserKeymap(client, userId, overrides) {
  if (Object.keys(overrides || {}).length) {
    await client.userData.put(userId, keymapDataKey(), { metadata: overrides });
    return;
  }
  try {
    await client.userData.delete(userId, keymapDataKey());
  } catch (e) {
    if (e?.status !== 404) throw e;
  }
}
