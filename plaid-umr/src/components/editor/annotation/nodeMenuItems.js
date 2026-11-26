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
//
// Each label is a message, shown through t() by NodeMenu.
import { msg } from '@ui/lib/i18n.js';

export const ITEMS = [
  [['node.confirm', msg('Accept')]],
  [
    ['node.concept', msg('Edit concept'), 'fixed:canvas:Enter'],
    ['node.takeEntry', msg('Take entry value')],
    ['node.takeEntryAll', msg('Take entry value for all nodes')],
    ['node.relation', msg('Relation to parent')],
    ['node.attributes', msg('Attributes')],
    ['node.variable', msg('Rename variable')],
  ],
  [
    ['node.child', msg('Add a child'), 'fixed:canvas:Tab'],
    ['node.anchor', msg('Change anchor')],
    ['node.move', msg('Move under another node')],
    ['node.reentrancy', msg('Add a second parent')],
    ['node.earlier', msg('Move earlier')],
    ['node.later', msg('Move later')],
    ['node.root', msg('Make this the root')],
  ],
  [
    ['node.coref', msg('Coreference')],
    ['node.temporal', msg('Temporal relation')],
    ['node.modal', msg('Modal relation')],
    ['node.docRelations', msg('Change a document relation')],
  ],
  [
    ['node.delete', msg('Delete relation to parent')],
    ['node.deleteNode', msg('Delete node and all below it')],
  ],
];
