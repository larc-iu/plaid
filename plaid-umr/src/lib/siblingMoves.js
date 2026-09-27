// Move earlier and Move later are READING order. In an RTL sentence the
// earlier sibling is the one to the right, so there Left and Right trade
// places in the chords bound to the two moves, as the plain arrows do
// (`arrowStep`): the node goes the way the key points. The CHORD is mirrored,
// not the action, so a person who put one move on another key still has one
// key for each. Any other action on a sideways arrow means what it says.

import { chordText } from '@ui/lib/chords.js';

const MOVES = ['node.earlier', 'node.later'];
const MIRROR = { ArrowLeft: 'ArrowRight', ArrowRight: 'ArrowLeft' };

const mirrorChord = (chord) => chord.replace(/Arrow(Left|Right)$/, (arrow) => MIRROR[arrow]);

// The same keydown with Left and Right traded, for `keys.which`.
const mirrorEvent = (e) => ({
  key: MIRROR[e.key],
  code: MIRROR[e.code] ?? e.code,
  altKey: e.altKey,
  ctrlKey: e.ctrlKey,
  metaKey: e.metaKey,
  shiftKey: e.shiftKey,
  getModifierState: (k) => !!e.getModifierState?.(k),
});

/** The action of `ids` this keydown fires in a sentence read `direction`. */
export function whichInDirection(keys, ids, e, direction) {
  const action = keys.which(ids, e);
  if (direction !== 'rtl' || !MIRROR[e.key]) return action;
  const mirrored = keys.which(MOVES, mirrorEvent(e));
  if (mirrored) return mirrored;
  // A move's own sideways chord is answered by its mirror image here.
  return MOVES.includes(action) ? null : action;
}

/** The action's first chord in words, as it is pressed in this sentence. */
export function wordsInDirection(keys, id, direction) {
  const chord = keys.chords(id)[0];
  if (direction !== 'rtl' || !MOVES.includes(id)) return keys.words(id);
  return chordText(mirrorChord(chord), { words: true });
}
