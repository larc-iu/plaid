import { Kbd as Key } from '@ui/components/shared/Kbd.jsx';
import { LegendRow as Row } from '@ui/components/shared/LegendRow.jsx';
import { MarksRow } from '@ui/components/shared/MarksRow.jsx';
import { t, tx } from '@ui/lib/i18n.js';

// The grid's gestures and marks, the help of the Annotate tab's RunBar, so
// they are one click away and nothing while you work. It replaces the single
// tip line that used to sit over the grid and could only ever name one
// gesture out of a dozen. Keep it in step with the guide's Keyboard Shortcuts
// table (C5).
//
// Each row is one message, its keys marked `<kbd>` and drawn as keycaps.

const tags = {
  kbd: (c) => <Key>{c}</Key>,
  strong: (c) => <strong>{c}</strong>,
};

export const EditorLegend = ({ project }) => {
  return (
    <>
      <MarksRow project={project} lowConfidence>
        {t('plain: settled. A dashed arc in the tree marks an unreviewed relation.')}
      </MarksRow>

      <Row title={t('Review')}>
        {tx(
          '<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>↵</kbd> to accept a word and move to the next · <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>⌫</kbd> to discard the machine’s work on it · <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>⇧</kbd>+<kbd>↑</kbd><kbd>↓</kbd> to jump to the next word needing a look. The buttons under a sentence do the whole sentence.',
          tags,
        )}
      </Row>

      <Row title={t('Grid')}>
        {tx(
          '<kbd>Tab</kbd> next cell, <kbd>⇧</kbd>+ previous · <kbd>↑</kbd><kbd>↓</kbd> to move between rows · <kbd>←</kbd><kbd>→</kbd> to move along the row from the ends of a value · <kbd>↵</kbd> to commit, <kbd>Esc</kbd> to cancel · in FEATS, <kbd>⌫</kbd> on the empty input to select the last feature.',
          tags,
        )}
      </Row>

      <Row title={t('Text')}>
        {tx(
          '<kbd>Alt</kbd>+click a word to open its sentence in the Text Editor, or <strong>Edit text</strong> under the sentence. <kbd>Alt</kbd>+click a token there to come back to it here.',
          tags,
        )}
      </Row>

      <Row title={t('Precedent')}>
        {tx(
          '<kbd>Alt</kbd>+<kbd>↓</kbd> in a lemma, XPOS or FEATS cell to list what this project has given words like this one, with counts. The lemma asks about the form, the other two about the lemma.',
          tags,
        )}
      </Row>

      <Row title={t('Tree')}>
        {tx(
          'Drag from one word to another to draw a relation, or from the grey band across the top of the tree to a word to mark the root · click a label to rename it · <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>D</kbd> to jump into the labels, <kbd>←</kbd><kbd>→</kbd> to move between them, <kbd>↵</kbd> to edit, <kbd>↓</kbd> to drop back into the grid.',
          tags,
        )}
      </Row>

      <Row title={t('Enhanced')}>
        {tx(
          'Start drawing a relation with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> held to add it to the enhanced graph, shown under the words. Drawn over a relation of the tree, it gives that relation a different label there · <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+click a relation of the tree, or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>E</kbd> on its label, to leave it out of the enhanced graph, shown faded · <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>D</kbd> from the tree’s labels to move to the ones under the words, and back.',
          tags,
        )}
      </Row>
    </>
  );
};
