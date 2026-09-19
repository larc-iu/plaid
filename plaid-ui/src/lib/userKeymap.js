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

// The account's map with one screen's change laid over it: the actions whose
// binding differs between `before` and `next`, and no others.
const withChange = (stored, before, next) => {
  const merged = { ...stored };
  const ids = new Set([...Object.keys(before || {}), ...Object.keys(next || {})]);
  ids.forEach((id) => {
    const was = JSON.stringify(before?.[id] ?? null);
    const now = JSON.stringify(next?.[id] ?? null);
    if (was === now) return;
    if (next?.[id]) merged[id] = next[id];
    else delete merged[id];
  });
  return merged;
};

/**
 * Save one screen's change: `before` is what it held when the change was
 * made and `next` what it holds now. Only the actions that differ are
 * written, over whatever the account holds at the time, so a second tab, or
 * one whose own read has not landed yet, no longer writes its single binding
 * over every other. `replace` writes `next` whole, which is what Reset all
 * means. Nothing stored is nothing kept.
 *
 * Resolves to the account's map as it now stands.
 */
export async function saveUserKeymap(client, userId, { before = {}, next = {}, replace = false }) {
  const merged = replace
    ? { ...next }
    : withChange(await loadUserKeymap(client, userId), before, next);
  if (Object.keys(merged).length) {
    await client.userData.put(userId, keymapDataKey(), { metadata: merged });
    return merged;
  }
  try {
    await client.userData.delete(userId, keymapDataKey());
  } catch (e) {
    if (e?.status !== 404) throw e;
  }
  return {};
}
