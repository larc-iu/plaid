// The attribution note prepended to an imported comment.
//
// `plaid.sql.comment/create!` stamps `author_id` from the authenticated caller
// and both timestamps from `now`, deliberately and with no override: nobody,
// maintainers and admins included, may put words in another user's mouth. So
// an imported comment is authored by whoever ran the import and dated today,
// and the body is the only place the original attribution can survive.
//
// It goes in as a Markdown blockquote, which renders as a note ABOVE the
// comment rather than as the comment's own first sentence.

/** Mirrors `plaid.sql.comment/max-body-length`. */
export const MAX_BODY_LENGTH = 10000;

const OPENING = '> Imported from an archive.';

// A note this module wrote previously: the opening line, plus any further
// blockquote lines it wrapped onto, plus the blank line that separates it from
// the body. Anchored at the start and requiring the exact opening, so a
// quotation of one inside a real comment is left alone.
const NOTE_RE = /^> Imported from an archive\.[^\n]*(?:\n>[^\n]*)*\n*/;

/**
 * `Ada Lovelace <ada@example.com>`, or the bare id when there is no display
 * name to add. The id IS the email, so this is the whole identity.
 */
export function formatAuthor(author) {
  const id = author?.id ?? null;
  const name = author?.name ?? null;
  if (!id) return name || 'an unknown author';
  return name && name !== id ? `${name} <${id}>` : id;
}

/**
 * The date portion of an ISO timestamp, for prose. Anything that is not
 * plainly ISO is passed through as-is rather than guessed at.
 */
export function formatDate(iso) {
  const s = String(iso ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

/**
 * Remove a note this module wrote, if the body opens with one. Exported so a
 * round-trip check can compare the words a person actually typed without
 * re-deriving the marker and letting the two drift apart.
 */
export const stripAttribution = (body) => String(body ?? '').replace(NOTE_RE, '');

/**
 * The body to post for an archived comment.
 *
 * Returns `{ body, attributed }`. `attributed` is false when the note was
 * dropped because it would push the comment past the server's ceiling — the
 * author's own words are never truncated to make room for our annotation.
 *
 * Any note this module wrote on a previous import is stripped first, so a
 * project exported and re-imported repeatedly does not accumulate a stack of
 * them. The surviving note describes what THIS archive recorded, which is the
 * honest claim: after two hops the archive's own author is the first importer.
 */
export function attributedBody(comment) {
  const original = stripAttribution(comment?.body);
  const author = formatAuthor(comment?.author);
  const date = formatDate(comment?.createdAt);
  const note = date
    ? `${OPENING} Originally posted by ${author} on ${date}.`
    : `${OPENING} Originally posted by ${author}.`;
  const withNote = `${note}\n\n${original}`;
  if (!original) return { body: note, attributed: true };
  if (withNote.length > MAX_BODY_LENGTH) return { body: original, attributed: false };
  return { body: withNote, attributed: true };
}
