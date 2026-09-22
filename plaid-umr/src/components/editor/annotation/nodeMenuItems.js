// Every action of a node, on the mouse. The keyboard reaches all of these
// too, and the menu says with which key, so it teaches the shortcuts rather
// than competing with them. Both call one `runAction`, so a gesture cannot
// mean two different things depending on how it was reached.
//
// `fixed:canvas:Enter` is the concept editor's key and `fixed:canvas:Tab`
// the new child's: positional keys nobody can rebind, listed here the same
// as the rest. Tab asks for the child by typing where the menu's item waits
// for a click, and either ends in the same concept and role. The chords are
// read in WORDS (Enter, Shift+Backspace) rather than as keycaps: a menu row
// is a sentence, and ⇧⌫ in the middle of one is a puzzle. The FIRST chord
// only: an action with two (Backspace and Delete) would otherwise print both
// and push the label into wrapping.
//
// In a file of its own so `actionTables.test.js` can hold this table, the
// keymap and `runAction` against each other: the three used to be able to
// drift into a bound key that did nothing or a menu row that did nothing.
export const ITEMS = [
  [
    ['node.concept', 'Edit concept', 'fixed:canvas:Enter'],
    ['node.relation', 'Relation to parent'],
    ['node.attributes', 'Attributes'],
    ['node.variable', 'Rename variable'],
  ],
  [
    ['node.child', 'Add a child', 'fixed:canvas:Tab'],
    ['node.anchor', 'Change anchor'],
    ['node.move', 'Move under another node'],
    ['node.reentrancy', 'Add a second parent'],
    ['node.earlier', 'Move earlier'],
    ['node.later', 'Move later'],
    ['node.root', 'Make this the root'],
  ],
  [
    ['node.coref', 'Coreference'],
    ['node.temporal', 'Temporal relation'],
    ['node.modal', 'Modal relation'],
  ],
  [
    ['node.delete', 'Delete relation to parent'],
    ['node.deleteNode', 'Delete node and all below it'],
  ],
];
