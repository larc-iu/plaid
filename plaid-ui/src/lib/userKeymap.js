// One person's keyboard bindings, kept on their account so they follow them
// between machines. Unlike a sort order or a page size (useStickyState), which
// describe a screen, a binding describes a person: the hand that learned it.
//
// Stored as the keymap's override diff under one key per app. The map sits
// under `metadata` because its keys are action ids, and the client recases
// every other object key on the way out and back (see `userData.put`).

import { configNamespace } from './uiConfig.js';

const keymapDataKey = () => `${configNamespace()}:keymap`;

/** The person's overrides, or {} when they have none. */
export async function loadUserKeymap(client, userId) {
  try {
    const entry = await client.userData.get(userId, keymapDataKey());
    const map = entry?.value?.metadata;
    return map && typeof map === 'object' ? map : {};
  } catch (e) {
    if (e?.status === 404) return {};
    throw e;
  }
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
