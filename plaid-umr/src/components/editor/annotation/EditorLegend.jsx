import { Fragment, useSyncExternalStore } from 'react';
import { readReview } from '@larc-iu/plaid-client';
import { chordCaps } from '@ui/lib/chords.js';
import { keys } from '../../../lib/keymap.js';

// The canvas's keys, gestures and marks, behind a `?` disclosure over the
// sentences, as plaid-ud's EditorLegend is over its grid. Every rebindable key
// is printed from the keymap, so a person's own binding is what it shows. Keep
// it in step with the guide's Keyboard reference.

const Kbd = ({ children }) => (
  <kbd className="rounded border border-border bg-muted px-1 py-px font-sans text-[10px] leading-none text-foreground">
    {children}
  </kbd>
);

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

const Row = ({ title, children }) => (
  <div className="flex gap-3 py-1">
    <strong className="w-24 shrink-0 font-medium text-foreground">{title}</strong>
    <span className="min-w-0">{children}</span>
  </div>
);

export const EditorLegend = ({ project, direction = 'ltr' }) => {
  // Re-read when the person's bindings arrive or change.
  useSyncExternalStore(keys.subscribe, keys.overrides);
  const k = (id) => <Caps caps={capsOf(id, direction)} />;
  // The amber mark only means something in a project that reviews somebody's
  // work, as in plaid-ud's legend.
  const review = readReview(project?.config);
  const reviewsSomeone = review.users.length > 0 || review.roles.length > 0;

  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded px-1 py-0.5 hover:bg-muted [&::-webkit-details-marker]:hidden">
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border font-medium">
          ?
        </span>
        <span className="group-open:hidden">Keys and marks</span>
        <span className="hidden group-open:inline">Hide</span>
      </summary>

      <div className="mt-2 max-w-3xl rounded-md border border-border bg-muted/30 px-3 py-2">
        <Row title="Marks">
          <span className="plaid-prov--machine">machine-made</span>
          {' · '}
          {reviewsSomeone && (
            <>
              <span className="plaid-prov--contributed">contributed</span>
              {' · '}
            </>
          )}
          plain: settled · a dashed grey border: no word · a red ring: an error · a magenta ring: a
          warning
        </Row>

        <Row title="Move">
          <Kbd>↑</Kbd> parent · <Kbd>↓</Kbd> first child · <Kbd>←</Kbd>
          <Kbd>→</Kbd> along the row · <Kbd>⇧</Kbd>+<Kbd>Tab</Kbd> out of the sentence ·{' '}
          <Kbd>Esc</Kbd> leaves a mode, closes a picker, or unfocuses the node
        </Row>

        <Row title="Make">
          <Kbd>Tab</Kbd> child of the focused node · {k('canvas.newRoot')} node with no parent ·{' '}
          {k('node.reentrancy')} second parent · drag the grip under a node onto a node, a word or
          empty space · double-click a word or empty space for a node with no parent
        </Row>

        <Row title="Change">
          <Kbd>↵</Kbd> concept · {k('node.relation')} relation to the parent ·{' '}
          {k('node.attributes')} attributes · {k('node.variable')} variable · {k('node.anchor')}{' '}
          anchor · {k('node.move')} move under another node · {k('node.earlier')} {k('node.later')}{' '}
          earlier or later among its siblings · {k('node.root')} make it the root
        </Row>

        <Row title="Document">
          {k('node.coref')} coreference · {k('node.temporal')} temporal · {k('node.modal')} modal ·{' '}
          {k('node.docRelations')} change or delete one of the node&rsquo;s document relations
        </Row>

        <Row title="Review">
          {k('node.confirm')} accepts the node and its relation to its parent. Accept graph and
          Discard graph in a sentence&rsquo;s header do the whole sentence.
        </Row>

        <Row title="Delete">
          {k('node.delete')} the relation to the parent, with what only it reached ·{' '}
          {k('node.deleteNode')} the node and everything under it
        </Row>

        <Row title="Mouse">
          A click focuses a node, and a double-click on one of its parts edits that part. A
          right-click or ⋯ lists every action with its key.
        </Row>
      </div>
    </details>
  );
};
