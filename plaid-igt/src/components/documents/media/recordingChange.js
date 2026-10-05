// What a page holding a document says when the recording it plays changed
// under it: deleted or replaced by someone else, and learned when the page
// read the document again (a write of its own refused as changed elsewhere,
// which a recording's upload or delete causes, or any other read). A
// recording that appears is not announced, since it shows, and neither is
// the page's own delete. A write with times chosen on the old recording is
// refused (mutations/alignment.js), and the notice says what went unsaved.

/**
 * @param {string|null} before  the document's mediaUrl as the page had it
 * @param {string|null} after   as it is now
 * @param {{ownDelete?: boolean, notSaved?: string|null}} [opts]  `ownDelete`:
 *   this page is deleting the recording. `notSaved`: what a write refused for
 *   the change left unsaved ("Segment").
 * @returns {{title: string, message: string}|null}
 */
export function recordingChangeNotice(before, after, { ownDelete = false, notSaved = null } = {}) {
  if (!before || before === after) return null;
  const lost = notSaved ? ` ${notSaved} not saved.` : '';
  if (!after)
    return ownDelete ? null : { title: 'Recording deleted', message: `Deleted elsewhere.${lost}` };
  return { title: 'Recording replaced', message: `Replaced elsewhere.${lost}` };
}
