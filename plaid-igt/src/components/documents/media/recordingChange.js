import { t } from '@ui/lib/i18n.js';

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
  if (!after) {
    return ownDelete
      ? null
      : { title: t('Recording deleted'), message: changedMessage('deleted', notSaved) };
  }
  return { title: t('Recording replaced'), message: changedMessage('replaced', notSaved) };
}

// `notSaved` is the name alignment.js gives what it refused: "Segment" and
// "Segment edit" have whole sentences of their own, and any other name goes
// into the sentence as it came.
function changedMessage(change, notSaved) {
  const deleted = change === 'deleted';
  if (!notSaved) return deleted ? t('Deleted elsewhere.') : t('Replaced elsewhere.');
  if (notSaved === 'Segment') {
    return deleted
      ? t('Deleted elsewhere. Segment not saved.')
      : t('Replaced elsewhere. Segment not saved.');
  }
  if (notSaved === 'Segment edit') {
    return deleted
      ? t('Deleted elsewhere. Segment edit not saved.')
      : t('Replaced elsewhere. Segment edit not saved.');
  }
  return deleted
    ? t('Deleted elsewhere. {what} not saved.', { what: notSaved })
    : t('Replaced elsewhere. {what} not saved.', { what: notSaved });
}
