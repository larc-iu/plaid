import { Fragment, useSyncExternalStore } from 'react';
import { chordCaps } from '@ui/lib/chords.js';
import { keys } from '../../../lib/keymap.js';
import { Kbd } from '@ui/components/shared/Kbd.jsx';
import { LegendRow as Row } from '@ui/components/shared/LegendRow.jsx';
import { MarksRow } from '@ui/components/shared/MarksRow.jsx';

// The canvas's keys, gestures and marks, the help of the Annotate tab's
// RunBar, as plaid-ud's EditorLegend is over its grid. Every rebindable key
// is printed from the keymap, so a person's own binding is what it shows. Keep
// it in step with the guide's Keyboard reference.

const Caps = ({ caps }) =>
  caps.map((cap, i) => (
    <Fragment key={i}>
      {i > 0 && '+'}
      <Kbd>{cap}</Kbd>
    </Fragment>
  ));

// Earlier and later are reading order, so in a right-to-left document the
// arrows of the two moves trade places, as they do on the node menu
// (siblingMoves.js). Only an arrow is mirrored: a move bound to a letter is
// the same key either way.
const MIRROR = { ArrowLeft: 'ArrowRight', ArrowRight: 'ArrowLeft' };
const capsOf = (id, direction) => {
  const chord = keys.chords(id)[0];
  if (direction !== 'rtl' || (id !== 'node.earlier' && id !== 'node.later')) {
    return keys.caps(id);
  }
  return chordCaps(chord.replace(/Arrow(Left|Right)$/, (arrow) => MIRROR[arrow]));
};

export const EditorLegend = ({ project, direction = 'ltr' }) => {
  // Re-read when the person's bindings arrive or change.
  useSyncExternalStore(keys.subscribe, keys.overrides);
  const k = (id) => <Caps caps={capsOf(id, direction)} />;

  return (
    <>
      <MarksRow project={project}>
        plain: settled · a dashed grey border: no word · a red ring: an error · an orange ring: a
        warning
      </MarksRow>

      <Row title="Move">
        <Kbd>↑</Kbd> parent · <Kbd>↓</Kbd> first child · <Kbd>←</Kbd>
        <Kbd>→</Kbd> along the row · {k('canvas.nextSentence')} {k('canvas.previousSentence')} next
        or previous sentence · <Kbd>Esc</Kbd> then <Kbd>Tab</Kbd> next sentence · <Kbd>⇧</Kbd>+
        <Kbd>Tab</Kbd> out of the sentence · <Kbd>Esc</Kbd> to leave a mode, close a picker, or
        unfocus the node
      </Row>

      <Row title="Make">
        <Kbd>Tab</Kbd> child of the focused node · {k('canvas.newRoot')} node with no parent ·{' '}
        {k('node.reentrancy')} second parent · drag the grip under a node onto a node, a word or
        empty space · double-click a word or empty space for a node with no parent
      </Row>

      <Row title="Change">
        <Kbd>↵</Kbd> concept · {k('node.relation')} relation to the parent · {k('node.attributes')}{' '}
        attributes · {k('node.variable')} variable · {k('node.anchor')} anchor, by clicking words or
        typing their numbers · {k('node.move')} to move under another node · {k('node.earlier')}{' '}
        {k('node.later')} earlier or later among its siblings · {k('node.root')} to make it the root
        · {k('node.takeEntry')} {k('node.takeEntryAll')} the new concept of a changed vocabulary
        entry, for the node or every node picked from it
      </Row>

      <Row title="Document">
        {k('node.coref')} coreference · {k('node.temporal')} temporal · {k('node.modal')} modal ·{' '}
        {k('node.docRelations')} to change or delete one of the node&rsquo;s document relations
      </Row>

      <Row title="Review">
        {k('node.confirm')} to accept the node and its relation to its parent. Accept graph and
        Discard graph in a sentence&rsquo;s header do the whole sentence.
      </Row>

      <Row title="Delete">
        {k('node.delete')} the relation to the parent, with what only it reached ·{' '}
        {k('node.deleteNode')} the node and everything under it
      </Row>

      <Row title="Mouse">
        Click to focus a node, and double-click one of its parts to edit that part. Right-click or ⋯
        to list every action with its key.
      </Row>
    </>
  );
};
