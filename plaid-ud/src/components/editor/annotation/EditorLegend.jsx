import { Kbd as Key } from '@ui/components/shared/Kbd.jsx';
import { LegendRow as Row } from '@ui/components/shared/LegendRow.jsx';
import { MarksRow } from '@ui/components/shared/MarksRow.jsx';

// The grid's gestures and marks, the help of the Annotate tab's RunBar, so
// they are one click away and nothing while you work. It replaces the single
// tip line that used to sit over the grid and could only ever name one
// gesture out of a dozen. Keep it in step with the guide's Keyboard Shortcuts
// table (C5).

export const EditorLegend = ({ project }) => {
  return (
    <>
      <MarksRow project={project} lowConfidence>
        plain: settled. A dashed arc in the tree marks an unreviewed relation.
      </MarksRow>

      <Row title="Review">
        <Key>Ctrl</Key>/<Key>Cmd</Key>+<Key>↵</Key> to accept a word and move to the next ·{' '}
        <Key>Ctrl</Key>/<Key>Cmd</Key>+<Key>⌫</Key> to discard the machine&rsquo;s work on it ·{' '}
        <Key>Ctrl</Key>/<Key>Cmd</Key>+<Key>⇧</Key>+<Key>↑</Key>
        <Key>↓</Key> to jump to the next word needing a look. The buttons under a sentence do the
        whole sentence.
      </Row>

      <Row title="Grid">
        <Key>Tab</Key> next cell, <Key>⇧</Key>+ previous · <Key>↑</Key>
        <Key>↓</Key> to move between rows · <Key>←</Key>
        <Key>→</Key> to move along the row from the ends of a value · <Key>↵</Key> to commit,{' '}
        <Key>Esc</Key> to cancel · in FEATS, <Key>⌫</Key> on the empty input to select the last
        feature.
      </Row>

      <Row title="Text">
        <Key>Alt</Key>+click a word to open its sentence in the Text Editor, or{' '}
        <strong>Edit text</strong> under the sentence. <Key>Alt</Key>+click a token there to come
        back to it here.
      </Row>

      <Row title="Precedent">
        <Key>Alt</Key>+<Key>↓</Key> in a lemma, XPOS or FEATS cell to list what this project has
        given words like this one, with counts. The lemma asks about the form, the other two about
        the lemma.
      </Row>

      <Row title="Tree">
        Drag from one word to another to draw a relation · click a label to rename it ·{' '}
        <Key>Ctrl</Key>/<Key>Cmd</Key>+<Key>D</Key> to jump into the labels, <Key>←</Key>
        <Key>→</Key> to move between them, <Key>↵</Key> to edit, <Key>↓</Key> to drop back into the
        grid.
      </Row>

      <Row title="Enhanced">
        Start drawing a relation with <Key>Ctrl</Key>/<Key>Cmd</Key> held to add it to the enhanced
        graph, shown under the words. Drawn over a relation of the tree, it gives that relation a
        different label there · <Key>Ctrl</Key>/<Key>Cmd</Key>+click a relation of the tree, or{' '}
        <Key>Ctrl</Key>/<Key>Cmd</Key>+<Key>E</Key> on its label, to leave it out of the enhanced
        graph, shown faded · <Key>Ctrl</Key>/<Key>Cmd</Key>+<Key>D</Key> from the tree&rsquo;s
        labels to move to the ones under the words, and back.
      </Row>
    </>
  );
};
