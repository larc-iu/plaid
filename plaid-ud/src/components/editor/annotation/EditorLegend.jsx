import { readReview } from '@larc-iu/plaid-client';

// The grid's gestures and marks, behind a `?` so they are one keystroke away
// and nothing while you work. It replaces the single tip line that used to sit
// over the grid and could only ever name one gesture out of a dozen.
//
// Native <details>, the idiom GrewHelp already uses: there is no accordion
// primitive in plaid-ui and one disclosure does not justify adding one. Keep it
// in step with the guide's Keyboard Shortcuts table (C5).

const Key = ({ children }) => (
  <kbd className="rounded border border-border bg-muted px-1 py-px font-sans text-[10px] leading-none text-foreground">
    {children}
  </kbd>
);

const Row = ({ title, children }) => (
  <div className="flex gap-3 py-1">
    <strong className="w-24 shrink-0 font-medium text-foreground">{title}</strong>
    <span className="min-w-0">{children}</span>
  </div>
);

export const EditorLegend = ({ project }) => {
  // The amber mark only means something in a project that reviews somebody's
  // work. Everywhere else there is no such thing as a contributed annotation,
  // and a legend row for it is a row about a feature nobody here has.
  const review = readReview(project?.config);
  const reviewsSomeone = review.users.length > 0 || review.roles.length > 0;

  return (
    <details className="group mt-3 text-xs text-muted-foreground">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded px-1 py-0.5 hover:bg-muted [&::-webkit-details-marker]:hidden">
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border font-medium">
          ?
        </span>
        <span className="group-open:hidden">Gestures and marks</span>
        <span className="hidden group-open:inline">Hide</span>
      </summary>

      <div className="mt-2 max-w-3xl rounded-md border border-border bg-muted/30 px-3 py-2">
        <Row title="Marks">
          <span className="italic text-[var(--plaid-machine)] underline decoration-dotted underline-offset-2">
            machine-made
          </span>
          {' · '}
          {reviewsSomeone && (
            <>
              <span className="italic text-[var(--plaid-contributed)] underline decoration-dotted underline-offset-2">
                contributed
              </span>
              {' · '}
            </>
          )}
          plain: settled. A dashed arc in the tree marks an unreviewed relation.
        </Row>

        <Row title="Review">
          <Key>Ctrl</Key>/<Key>Cmd</Key>+<Key>↵</Key> accepts a word and moves to the next ·{' '}
          <Key>Ctrl</Key>/<Key>Cmd</Key>+<Key>⌫</Key> discards the machine&rsquo;s work on it ·{' '}
          <Key>Ctrl</Key>/<Key>Cmd</Key>+<Key>⇧</Key>+<Key>↑</Key>
          <Key>↓</Key> jumps to the next word needing a look. The buttons under a sentence do the
          whole sentence.
        </Row>

        <Row title="Grid">
          <Key>Tab</Key> next cell, <Key>⇧</Key>+ previous · <Key>↑</Key>
          <Key>↓</Key> move rows · <Key>←</Key>
          <Key>→</Key> move along the row from the ends of a value · <Key>↵</Key> commits,{' '}
          <Key>Esc</Key> cancels · in FEATS, <Key>⌫</Key> on the empty input selects the last
          feature.
        </Row>

        <Row title="Text">
          <Key>Alt</Key>+click a word to open its sentence in the Text Editor, or{' '}
          <strong>Edit text</strong> under the sentence. <Key>Alt</Key>+click a token there comes
          back to it here.
        </Row>

        <Row title="Tree">
          Drag from one word to another to draw a relation · click a label to rename it ·{' '}
          <Key>Ctrl</Key>/<Key>Cmd</Key>+<Key>D</Key> jumps into the labels, <Key>←</Key>
          <Key>→</Key> move between them, <Key>↵</Key> edits, <Key>↓</Key> drops back into the grid.
        </Row>
      </div>
    </details>
  );
};
