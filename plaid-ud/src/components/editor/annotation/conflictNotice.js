import { statusOf } from '@ui/lib/errors.js';

// A cell's write. A cell edit refused because someone else changed the cell
// first shows the stored value, with the refused one under it
// (unsentValues.js), and the toast that names the change ("b changed this to
// NOUN.") is plaid-ui's (cellConflict.js), shared with plaid-igt.

/**
 * Write a cell's value. Answers what `updateAnnotation` does, or for a
 * refusal `{ refused: true, status, error, readBack }`, so the cell can tell
 * one that sending again could mend from one it cannot (see EditableCell).
 * `readBack` is true when the refetch after the refusal landed, so what the
 * document holds is what the server holds. The cell reports a conflict
 * itself, so the document raises no toast of its own for one.
 */
export async function writeCell(doc, tokenId, field, value) {
  const ok = await doc.handlesConflicts(() => doc.updateAnnotation(tokenId, field, value));
  if (ok !== false) return ok;
  const error = doc.errorCause;
  return { refused: true, status: statusOf(error), error, readBack: !doc.outOfStep };
}
