// A keymap: an app's table of actions, the chords bound to them, and one
// person's changes on top. See chords.js for what a chord is.
//
// An ACTION is `{ id, scope, group, label, keys, fixed?, outsideText? }`.
//
//   keys         the default chords. Several when more than one key means the
//                same thing (Ctrl+Backspace and Ctrl+Delete).
//   scope        where the action listens, as a dotted path ('analyze',
//                'analyze.popover', 'media'). Two actions can share a chord
//                only when neither scope contains the other. 'global' contains
//                everything.
//   fixed        a key whose meaning is positional (Enter moves on, the arrows
//                move, Escape backs out) or that some other layer owns. It
//                cannot be rebound and is here so that nothing else can be
//                bound over it.
//   outsideText  the action never fires from inside a text box, so it may be a
//                bare character (Space, `/`). Anything else has to carry Mod or
//                Alt, or be a key that types nothing.
//
// OVERRIDES are a diff, `{ [actionId]: [chord, ...] }`, holding only what a
// person changed, for the reason compose codes are stored that way: an action
// nobody touched keeps following its default when the default changes. An
// override replaces the action's defaults whole. It can never unbind: an empty
// or unusable one reads as "no change".

import {
  canonicalChord,
  chordCaps,
  chordText,
  chordTypes,
  chordsOf,
  isReservedChord,
} from './chords.js';

const contains = (outer, inner) =>
  outer === 'global' || outer === inner || inner.startsWith(`${outer}.`);
const scopesOverlap = (a, b) => contains(a, b) || contains(b, a);

export function createKeymap(actionList) {
  const actions = actionList.map((a) => ({
    ...a,
    keys: a.keys.map((k) => {
      const c = canonicalChord(k);
      if (!c) throw new Error(`keymap: "${k}" on ${a.id} is not a chord`);
      return c;
    }),
  }));
  const byId = new Map(actions.map((a) => [a.id, a]));
  if (byId.size !== actions.length) throw new Error('keymap: duplicate action id');

  let overrides = {};
  let bound = new Map();
  const listeners = new Set();

  // Only what is usable survives: a known, rebindable action and real chords.
  const clean = (raw) => {
    const out = {};
    for (const [id, chords] of Object.entries(raw || {})) {
      const action = byId.get(id);
      if (!action || action.fixed || !Array.isArray(chords)) continue;
      const keys = [...new Set(chords.map(canonicalChord).filter(Boolean))];
      const same = keys.length === action.keys.length && keys.every((k) => action.keys.includes(k));
      if (keys.length && !same) out[id] = keys;
    }
    return out;
  };
  const rebuild = () => {
    bound = new Map(actions.map((a) => [a.id, overrides[a.id] ?? a.keys]));
  };
  rebuild();

  const chords = (id) => {
    const keys = bound.get(id);
    // A typo in an action id would otherwise be a shortcut that silently
    // never fires.
    if (!keys) throw new Error(`keymap: no action "${id}"`);
    return keys;
  };

  const keymap = {
    actions,
    action: (id) => byId.get(id) ?? null,
    chords,

    /** Is this keydown the chord bound to the action? */
    is(id, e) {
      const keys = chords(id);
      const pressed = chordsOf(e);
      return pressed.some((c) => keys.includes(c));
    },
    /** The first of `ids` this keydown is bound to, or null. */
    which(ids, e) {
      return ids.find((id) => keymap.is(id, e)) ?? null;
    },

    /** Keycaps for the action's first chord, for a legend. */
    caps: (id, opts) => chordCaps(chords(id)[0], opts),
    /** Every chord of the action as text: `Ctrl+⌫ / Ctrl+Del`. */
    text: (id, opts) =>
      chords(id)
        .map((c) => chordText(c, opts))
        .join(' / '),
    /** The first chord in words, for a sentence: `Ctrl+Enter`. */
    words: (id, opts) => chordText(chords(id)[0], { ...opts, words: true }),
    isChanged: (id) => !!overrides[id],

    overrides: () => overrides,
    setOverrides(raw) {
      overrides = clean(raw);
      rebuild();
      listeners.forEach((fn) => fn());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * May `chord` be bound to `id`, given everything else as it stands (or as
     * `draft` overrides would leave it)? Returns null when it may, otherwise
     * `{ problem, with? }` where problem is 'invalid', 'fixed', 'reserved',
     * 'types' or 'conflict' and `with` is the action already holding it.
     */
    check(id, chord, draft = overrides) {
      const action = byId.get(id);
      const c = canonicalChord(chord);
      if (!action || !c) return { problem: 'invalid' };
      if (action.fixed) return { problem: 'fixed' };
      if (isReservedChord(c)) return { problem: 'reserved' };
      // An action's own default is always allowed back: Shift+Space types a
      // blank, and the Media rows claim it on purpose.
      if (chordTypes(c) && !action.outsideText && !action.keys.includes(c)) {
        return { problem: 'types' };
      }
      const draftKeys = clean(draft);
      for (const other of actions) {
        if (other.id === id || !scopesOverlap(other.scope, action.scope)) continue;
        if ((draftKeys[other.id] ?? other.keys).includes(c)) {
          return { problem: 'conflict', with: other };
        }
      }
      return null;
    },

    /**
     * The overrides with `id` bound to `chord`, or back on its default for null.
     *
     * Going back to a default is not checked the way a new chord is, because it
     * must always be possible. But the default may have been given away in the
     * meantime (move A off Ctrl+Enter, bind B to it, reset A), which would leave
     * two actions on one chord and the second of them dead. So whoever took it
     * goes back to their own default too, and so on until nothing collides.
     * Each round removes an override, so it ends.
     */
    withBinding(id, chord, draft = overrides) {
      const next = { ...clean(draft) };
      if (chord != null) {
        next[id] = [chord];
        return clean(next);
      }
      const restore = [id];
      while (restore.length) {
        const action = byId.get(restore.pop());
        if (!action) continue;
        delete next[action.id];
        for (const other of actions) {
          if (other.id === action.id || !next[other.id]) continue;
          if (!scopesOverlap(other.scope, action.scope)) continue;
          if (next[other.id].some((c) => action.keys.includes(c))) restore.push(other.id);
        }
      }
      return next;
    },
  };
  return keymap;
}
