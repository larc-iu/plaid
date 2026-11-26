import { Fragment, useSyncExternalStore } from 'react';
import { chordCaps } from '@ui/lib/chords.js';
import { keys } from '../../../lib/keymap.js';
import { Kbd } from '@ui/components/shared/Kbd.jsx';
import { LegendRow as Row } from '@ui/components/shared/LegendRow.jsx';
import { MarksRow } from '@ui/components/shared/MarksRow.jsx';
import { t, tc, tx } from '@ui/lib/i18n.js';

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

// A row's clauses, each a message of its own, with a dot between them.
const Clauses = ({ list }) =>
  list.map((clause, i) => (
    <Fragment key={i}>
      {i > 0 && ' · '}
      {clause}
    </Fragment>
  ));

// Key names stay as the keyboard shows them.
const ESC = <Kbd>Esc</Kbd>; // i18n-ignore: a key name
const TAB = <Kbd>Tab</Kbd>; // i18n-ignore: a key name
const UP = <Kbd>↑</Kbd>;
const DOWN = <Kbd>↓</Kbd>;
const LEFT = <Kbd>←</Kbd>;
const RIGHT = <Kbd>→</Kbd>;
const SHIFT = <Kbd>⇧</Kbd>;
const ENTER = <Kbd>↵</Kbd>;

export const EditorLegend = ({ project, direction = 'ltr' }) => {
  // Re-read when the person's bindings arrive or change.
  useSyncExternalStore(keys.subscribe, keys.overrides);
  const k = (id) => <Caps caps={capsOf(id, direction)} />;

  return (
    <>
      <MarksRow project={project}>
        <Clauses
          list={[
            t('plain: settled'),
            t('a dashed grey border: no word'),
            t('a red ring: an error'),
            t('an orange ring: a warning'),
          ]}
        />
      </MarksRow>

      <Row title={t('Move')}>
        <Clauses
          list={[
            tx('{up} parent', { up: UP }),
            tx('{down} first child', { down: DOWN }),
            tx('{left}{right} along the row', { left: LEFT, right: RIGHT }),
            tx('{next} {previous} next or previous sentence', {
              next: k('canvas.nextSentence'),
              previous: k('canvas.previousSentence'),
            }),
            tx('{esc} then {tab} next sentence', { esc: ESC, tab: TAB }),
            tx('{shift}+{tab} out of the sentence', { shift: SHIFT, tab: TAB }),
            tx('{esc} to leave a mode, close a picker, or unfocus the node', { esc: ESC }),
          ]}
        />
      </Row>

      <Row title={t('Make')}>
        <Clauses
          list={[
            tx('{tab} child of the focused node', { tab: TAB }),
            tx('{key} node with no parent', { key: k('canvas.newRoot') }),
            tx('{key} second parent', { key: k('node.reentrancy') }),
            t('drag the grip under a node onto a node, a word or empty space'),
            t('double-click a word or empty space for a node with no parent'),
          ]}
        />
      </Row>

      <Row title={tc('verb', 'Change')}>
        <Clauses
          list={[
            tx('{enter} concept', { enter: ENTER }),
            tx('{key} relation to the parent', { key: k('node.relation') }),
            tx('{key} attributes', { key: k('node.attributes') }),
            tx('{key} variable', { key: k('node.variable') }),
            tx('{key} anchor, by clicking words or typing their numbers', {
              key: k('node.anchor'),
            }),
            tx('{key} to move under another node', { key: k('node.move') }),
            tx('{earlier} {later} earlier or later among its siblings', {
              earlier: k('node.earlier'),
              later: k('node.later'),
            }),
            tx('{key} to make it the root', { key: k('node.root') }),
            tx(
              '{one} {all} the new concept of a changed vocabulary entry, for the node or every node picked from it',
              { one: k('node.takeEntry'), all: k('node.takeEntryAll') },
            ),
          ]}
        />
      </Row>

      <Row title={t('Document')}>
        <Clauses
          list={[
            tx('{key} coreference', { key: k('node.coref') }),
            tx('{key} temporal', { key: k('node.temporal') }),
            tx('{key} modal', { key: k('node.modal') }),
            tx('{key} to change or delete one of the node’s document relations', {
              key: k('node.docRelations'),
            }),
          ]}
        />
      </Row>

      <Row title={t('Review')}>
        {tx(
          '{key} to accept the node and its relation to its parent. Accept graph and Discard graph in a sentence’s header do the whole sentence.',
          { key: k('node.confirm') },
        )}
      </Row>

      <Row title={t('Delete')}>
        <Clauses
          list={[
            tx('{key} the relation to the parent, with what only it reached', {
              key: k('node.delete'),
            }),
            tx('{key} the node and everything under it', { key: k('node.deleteNode') }),
          ]}
        />
      </Row>

      <Row title={t('Mouse')}>
        {t(
          'Click to focus a node, and double-click one of its parts to edit that part. Right-click or ⋯ to list every action with its key.',
        )}
      </Row>
    </>
  );
};
