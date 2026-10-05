import { Fragment } from 'react';
import { detectDirection } from '@ui/domain/textDirection.js';

// The Export tab's view of the CoNLL-U file, read-only.
//
// A file is a list of rows whose tab-separated columns keep one order,
// whatever script the values are in. A plain text box cannot show that: on an
// Arabic row the FORM and the LEMMA, with only a tab between them, form one
// right-to-left run, and the browser draws the lemma first. So every field of
// such a row is isolated in a `bdi` of its own, and the row itself runs left to
// right like the file does. A comment's value (`# text = ...`) is isolated the
// same way, so an Arabic sentence keeps its full stop at its own end.
//
// Rows never wrap: a wrapped row's tail looks like a row of its own. A long row
// scrolls sideways in the box instead.
//
// A row of nothing but printable ASCII and tabs is left as plain text, which
// is how it would be drawn anyway, so an English treebank gets one element a
// row and no more.

const NON_ASCII = /[^\t -~]/u;

// An isolated field. One in a right-to-left script is drawn in the sans stack
// rather than the box's monospace, which stretches Arabic letters apart into
// fixed cells (the grid and the Text Editor dropped monospace for the same
// reason).
const Field = ({ value }) => (
  <bdi className={detectDirection(value) === 'rtl' ? 'font-sans' : undefined}>{value}</bdi>
);

const Row = ({ line }) => {
  if (!NON_ASCII.test(line)) return line;
  if (line.startsWith('#')) {
    // The key and its `=` stay as they are, and what follows is the value.
    const eq = line.indexOf(' = ');
    const cut = eq >= 0 ? eq + 3 : /^#\s?/u.exec(line)[0].length;
    return (
      <>
        {line.slice(0, cut)}
        <Field value={line.slice(cut)} />
      </>
    );
  }
  return line.split('\t').map((value, i) => (
    <Fragment key={i}>
      {i > 0 && '\t'}
      <Field value={value} />
    </Fragment>
  ));
};

export const ConlluPreview = ({ content }) => {
  // The file ends with a newline, which ends its last row and starts none.
  const lines = content.replace(/\n$/, '').split('\n');
  return (
    // Focusable so the sideways scroll can be reached from the keyboard, and a
    // region so the name it is given is announced (a bare `pre` carries none).
    <pre
      dir="ltr"
      tabIndex={0}
      role="region"
      aria-label="CoNLL-U file"
      data-testid="conllu-preview"
      className="max-h-[400lh] w-full overflow-auto whitespace-pre rounded-md border bg-muted/40 p-3 text-left font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {/* A block a row, not one inline run of the whole file: a file of
          26,000 rows was one layout of about 80 s as a single run, 3 s as
          blocks. A blank row keeps a line's height. Copy and Download use the
          file's text, not this. */}
      {lines.map((line, i) => (
        <span key={i} className="conllu-row block min-h-[1lh]">
          <Row line={line} />
        </span>
      ))}
    </pre>
  );
};
