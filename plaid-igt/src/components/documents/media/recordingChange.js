// What a page holding a document says when the recording it plays changed
// under it: deleted or replaced by someone else, and learned when the page
// read the document again (a write of its own refused as changed elsewhere,
// which a recording's upload or delete causes, or any other read). A
// recording that appears is not announced, since it shows, and neither is
// the page's own delete.

/**
 * @param {string|null} before  the document's mediaUrl as the page had it
 * @param {string|null} after   as it is now
 * @param {{ownDelete?: boolean}} [opts]  this page is deleting the recording
 * @returns {{title: string, message: string}|null}
 */
export function recordingChangeNotice(before, after, { ownDelete = false } = {}) {
  if (!before || before === after) return null;
  if (!after)
    return ownDelete ? null : { title: 'Recording deleted', message: 'Deleted elsewhere.' };
  return { title: 'Recording replaced', message: 'Replaced elsewhere.' };
}
