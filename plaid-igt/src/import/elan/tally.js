// What an ELAN Add documents run did, in one line: the result panel and the
// toast both say it, so they never disagree. Each part is a phrase of its own,
// and the parts are a list.

import { t } from '@ui/lib/i18n.js';

/** "1 added, 2 kept, 1 replaced, a recording added to an existing document." */
export function elanTally(results) {
  const parts = [t('{n} added', { n: results.imported - results.redone })];
  if (results.copied) {
    parts.push(
      t('{n, plural, one {{n} added as a copy} other {{n} added as copies}}', {
        n: results.copied,
      }),
    );
  }
  if (results.skipped) parts.push(t('{n} kept', { n: results.skipped }));
  if (results.redone) parts.push(t('{n} replaced', { n: results.redone }));
  if (results.done) parts.push(t('{n} already imported', { n: results.done }));
  if (results.recordingsAdded) {
    parts.push(
      t(
        '{n, plural, one {a recording added to an existing document} other {{n} recordings added to existing documents}}',
        { n: results.recordingsAdded },
      ),
    );
  }
  if (results.recordingsUnused) {
    parts.push(
      t('{n, plural, one {a recording not used} other {{n} recordings not used}}', {
        n: results.recordingsUnused,
      }),
    );
  }
  return `${parts.join(', ')}.`;
}

/**
 * The failure panel's line under Replace them, when the run had deleted the
 * document it was replacing before the failure.
 */
export const replacedGoneLine = (name) =>
  t('“{name}” was deleted before its replacement was written. Retry import makes it again.', {
    name,
  });
