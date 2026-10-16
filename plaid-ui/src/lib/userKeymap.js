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
  return (await readUserKeymap(client, userId)).map;
}

// The account's map and the version it is stored at (0 when there is none).
async function readUserKeymap(client, userId) {
  const key = keymapDataKey();
  const { entries } = await client.userData.listPage(userId, {
    prefix: key,
    includeValues: true,
    limit: 10,
  });
  const entry = entries.find((e) => e.key === key);
  const map = entry?.value?.metadata;
  return { map: map && typeof map === 'object' ? map : {}, version: entry?.version ?? 0 };
}

const isVersionMismatch = (e) => e?.status === 409 && e?.responseData?.error === 'version-mismatch';

// The actions whose binding differs between `before` and `next`.
const changedIds = (before, next) =>
  [...new Set([...Object.keys(before || {}), ...Object.keys(next || {})])].filter(
    (id) => JSON.stringify(before?.[id] ?? null) !== JSON.stringify(next?.[id] ?? null),
  );

// The account's map with one screen's change laid over it: the actions whose
// binding differs between `before` and `next`, and no others.
const withChange = (stored, before, next) => {
  const merged = { ...stored };
  changedIds(before, next).forEach((id) => {
    if (next?.[id]) merged[id] = next[id];
    else delete merged[id];
  });
  return merged;
};

/**
 * A change refused because the account already binds its chord to another
 * action: one screen checked the chord against the bindings it had read, and
 * another tab or machine has since given that chord away. `found` is the
 * keymap's `check` answer ({ problem: 'conflict', with }), `chord` the chord,
 * and `stored` the account's map as it stands, for the screen to show.
 */
export class KeymapConflict extends Error {
  constructor({ found, chord, stored }) {
    super(`${chord} is already bound to ${found.with?.label ?? found.with?.id}.`);
    this.name = 'KeymapConflict';
    Object.assign(this, { found, chord, stored });
  }
}

// The merged map checked as one screen's change would be: a chord this change
// binds must be free in the account's map, and an action this change sends
// back to its default takes it back from whoever holds it now (the keymap's
// own reset cascade, run on the account's map).
const checked = (keymap, merged, stored, before, next) => {
  let out = merged;
  for (const id of changedIds(before, next)) {
    if (!next?.[id]) {
      out = keymap.withBinding(id, null, out);
      continue;
    }
    for (const chord of out[id] || []) {
      const found = keymap.check(id, chord, out);
      if (found?.problem === 'conflict') throw new KeymapConflict({ found, chord, stored });
    }
  }
  return out;
};

/**
 * Save one screen's change: `before` is what it held when the change was
 * made and `next` what it holds now. Only the actions that differ are
 * written, over whatever the account holds at the time, so a second tab, or
 * one whose own read has not landed yet, no longer writes its single binding
 * over every other. `replace` writes `next` whole, which is what Reset all
 * means. Nothing stored is nothing kept.
 *
 * With `keymap` (the app's, from createKeymap) the merged map is checked
 * before it is written: a chord the account has meanwhile bound to another
 * action is refused with a KeymapConflict, since two tabs that each found it
 * free would otherwise bind two actions to it.
 *
 * Resolves to the account's map as it now stands.
 */
export async function saveUserKeymap(
  client,
  userId,
  { before = {}, next = {}, replace = false, keymap = null },
) {
  let merged;
  let version;
  // The change is laid over the map as read, and written only over that
  // version of it: one another tab saved in between is read again, once.
  for (let attempt = 0; ; attempt += 1) {
    if (replace) merged = { ...next };
    else {
      const read = await readUserKeymap(client, userId);
      ({ version } = read);
      merged = withChange(read.map, before, next);
      if (keymap) merged = checked(keymap, merged, read.map, before, next);
    }
    if (!Object.keys(merged).length) break;
    try {
      await client.userData.put(
        userId,
        keymapDataKey(),
        { metadata: merged },
        version == null ? {} : { version },
      );
      return merged;
    } catch (e) {
      if (attempt > 0 || !isVersionMismatch(e)) throw e;
    }
  }
  try {
    await client.userData.delete(userId, keymapDataKey());
  } catch (e) {
    if (e?.status !== 404) throw e;
  }
  return {};
}
