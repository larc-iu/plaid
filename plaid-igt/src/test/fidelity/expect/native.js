// The native archive's round-trip expectation: what its loss list says an
// import gives back, as edits to the snapshots (see ./index.js).
//
// Everything in the IGT slice is carried, so the only change is how comments
// come back: re-posted by the importer, with the original author and date in a
// note at the top of the body. The note is read back off the imported side
// rather than written onto the expected one, because the date it holds is the
// comment's creation date, which a snapshot does not keep.

import { docs } from './snap.js';

const NOTE =
  /^> Imported from an archive\. Originally posted by (.+?)(?: on (\d{4}-\d{2}-\d{2}))?\.(?:\n\n|$)/;

/** `Name <id>` or a bare id, as formatAuthor in commentAttribution.js writes it. */
const authorId = (text) => text.match(/<([^<>]+)>$/)?.[1] ?? text;

function readNote(comment) {
  const m = comment.body.match(NOTE);
  if (!m) return;
  comment.body = comment.body.slice(m[0].length);
  comment.author = authorId(m[1]);
}

export default {
  id: 'native',
  strips: {},
  steps: [
    {
      keys: [
        'comment.document',
        'comment.text',
        'comment.sentence',
        'comment.word',
        'comment.morpheme',
        'comment.segment',
        'comment.annotation',
        'comment.entry',
        'comment.secondAuthor',
        'comment.markdown',
      ],
      // The imported comment's note names the author the export read, and what
      // follows the note is the body as it was. A comment with no note keeps
      // the importer as its author, which then differs from the source.
      apply(expected, actual) {
        for (const c of [
          ...docs(actual).flatMap((d) => d.comments),
          ...(actual.vocabularies || []).flatMap((v) => v.comments || []),
        ]) {
          readNote(c);
        }
      },
    },
  ],
};
