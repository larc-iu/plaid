// The native archive's round-trip expectation: what its loss list says an
// import gives back, as edits to the snapshots (see ./index.js).
//
// Everything in the IGT slice is carried, and so are other apps' layers, so
// the only change is how comments come back: re-posted by the importer, with the original author and date in a
// note at the top of the body. The note is read back off the imported side
// rather than written onto the expected one, because the date it holds is the
// comment's creation date, which a snapshot does not keep.

import { stableStringify } from '../stable.js';
import { docs } from './snap.js';

const NOTE =
  /^> Imported from an archive\. Originally posted by (.+?)(?: on (\d{4}-\d{2}-\d{2}))?\.(?:\n\n|$)/;

/** `Name <id>` or a bare id, as formatAuthor in commentAttribution.js writes it. */
const authorId = (text) => text.match(/<([^<>]+)>$/)?.[1] ?? text;

// Who posted a comment whose note an earlier import wrote: the importer, on
// either side, since that note is kept as it is (Luke's ruling R36).
const REPOSTER = '<the importer>';

const commentsOf = (s) => [
  ...docs(s).flatMap((d) => d.comments),
  ...(s.vocabularies || []).flatMap((v) => v.comments || []),
];

function readNote(comment) {
  const m = comment.body.match(NOTE);
  if (!m) return;
  comment.body = comment.body.slice(m[0].length);
  comment.author = authorId(m[1]);
}

export default {
  id: 'native',
  strips: {
    // A project holding two vocabularies with one name is refused outright,
    // which roundTrip.mjs checks on a project of its own (REFUSALS). No project
    // that is compared holds it, so there is nothing to take out.
    'vocab.duplicateName': () => {},
  },
  steps: [
    {
      keys: ['vocab.foreignConfig'],
      // On the core that still holds the source, its dictionary address is
      // taken, so the copy has none. On another core nothing holds it, and the
      // copy keeps it.
      apply(expected, actual, ctx) {
        if (!ctx.sameCore) return;
        for (const v of expected.vocabularies || []) {
          const dict = v.config?.dict;
          if (!dict || !('slug' in dict)) continue;
          const { slug: _slug, ...rest } = dict;
          const config = { ...v.config, dict: rest };
          if (!Object.keys(rest).length) delete config.dict;
          v.config = config;
        }
      },
    },
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
        'comment.relation',
        'comment.secondAuthor',
        'comment.markdown',
      ],
      // The imported comment's note names the author the export read, and what
      // follows the note is the body as it was. A comment with no note keeps
      // the importer as its author, which then differs from the source. A
      // comment that already opened with a note comes back as it was, the
      // note naming its first author, and posted by the importer, as it was
      // in the source by whoever imported it there.
      apply(expected, actual) {
        const keyOf = (c) => stableStringify([c.anchor, c.body]);
        const kept = new Set();
        for (const c of commentsOf(expected)) {
          if (!NOTE.test(c.body)) continue;
          kept.add(keyOf(c));
          c.author = REPOSTER;
        }
        for (const c of commentsOf(actual)) {
          if (kept.has(keyOf(c))) c.author = REPOSTER;
          else readNote(c);
        }
      },
    },
  ],
};
