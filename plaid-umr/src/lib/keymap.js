// This app's keyboard shortcuts, as one table. A handler asks `keys.is(id, e)`,
// a legend asks `keys.caps(id)`, and a person's own bindings (Profile,
// Keyboard) are laid over the defaults here. See @ui/lib/keymap.js for the
// shape of an action and @ui/lib/chords.js for the chord grammar.
//
// Positional keys stay put and are listed as `fixed` rows so nothing can be
// bound over them: the arrows move between nodes, Tab starts a child, Enter
// opens the concept, Escape backs out of a mode or a picker. Bare letters
// are `outsideText`: a node is not a text box, and a picker's input is.

import { createKeymap } from '@ui/lib/keymap.js';

const fixed = (scope, ...keyList) =>
  keyList.map((k) => ({
    id: `fixed:${scope}:${k}`,
    scope,
    group: null,
    label: k,
    keys: [k],
    fixed: true,
  }));

export const KEY_GROUPS = [
  { id: 'canvas', label: 'Canvas' },
  { id: 'node', label: 'Canvas: the focused node' },
];

export const KEY_ACTIONS = [
  // ---- the focused node -------------------------------------------------
  {
    id: 'node.relation',
    scope: 'canvas',
    group: 'node',
    label: 'Change the relation to the parent',
    keys: [':'],
    outsideText: true,
  },
  {
    id: 'node.attributes',
    scope: 'canvas',
    group: 'node',
    label: 'Edit the attributes',
    keys: ['a'],
    outsideText: true,
  },
  {
    id: 'node.variable',
    scope: 'canvas',
    group: 'node',
    label: 'Rename the variable',
    keys: ['v'],
    outsideText: true,
  },
  {
    id: 'node.anchor',
    scope: 'canvas',
    group: 'node',
    label: 'Change the anchor: click words, Escape to finish',
    keys: ['u'],
    outsideText: true,
  },
  {
    id: 'node.move',
    scope: 'canvas',
    group: 'node',
    label: 'Move under another node: click it',
    keys: ['m'],
    outsideText: true,
  },
  {
    id: 'node.earlier',
    scope: 'canvas',
    group: 'node',
    label: 'Move earlier among its siblings',
    keys: ['Alt+ArrowLeft'],
  },
  {
    id: 'node.later',
    scope: 'canvas',
    group: 'node',
    label: 'Move later among its siblings',
    keys: ['Alt+ArrowRight'],
  },
  {
    id: 'node.reentrancy',
    scope: 'canvas',
    group: 'node',
    label: 'Add a second parent: click it',
    keys: ['r'],
    outsideText: true,
  },
  {
    id: 'node.root',
    scope: 'canvas',
    group: 'node',
    label: 'Make this node the root',
    keys: ['Mod+Shift+R'],
  },
  {
    id: 'node.delete',
    scope: 'canvas',
    group: 'node',
    label: 'Delete the edge to the parent, with what only it reached',
    keys: ['Shift+Backspace', 'Shift+Delete'],
  },
  {
    id: 'node.deleteNode',
    scope: 'canvas',
    group: 'node',
    label: 'Delete the node and everything under it',
    keys: ['Mod+Shift+Backspace', 'Mod+Shift+Delete'],
  },
  {
    id: 'node.coref',
    scope: 'canvas',
    group: 'node',
    label: 'Coreference with another node: pick it',
    keys: ['c'],
    outsideText: true,
  },
  {
    id: 'node.temporal',
    scope: 'canvas',
    group: 'node',
    label: 'Temporal relation: pick the other end',
    keys: ['t'],
    outsideText: true,
  },
  {
    id: 'node.modal',
    scope: 'canvas',
    group: 'node',
    label: 'Modal relation: pick the conceiver',
    keys: ['o'],
    outsideText: true,
  },
  {
    id: 'canvas.newRoot',
    scope: 'canvas',
    group: 'canvas',
    label: 'New node with no parent',
    keys: ['n'],
    outsideText: true,
  },
  ...fixed('canvas', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Escape'),
];

export const keys = createKeymap(KEY_ACTIONS);

// The canvas actions a key can reach, in one list, for `keys.which`. Derived
// rather than restated: a row added to the table above used to need adding
// to a second list in SentenceBlock as well, and a key bound in one and
// missing from the other did nothing at all. The `fixed` rows are left out
// because the canvas handles those positional keys itself, by name.
export const CANVAS_ACTIONS = KEY_ACTIONS.filter((a) => !a.fixed).map((a) => a.id);
