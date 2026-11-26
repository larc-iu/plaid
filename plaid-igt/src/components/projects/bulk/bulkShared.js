import { useMemo, useState } from 'react';
import { isReviewed, writerPolicy } from '@larc-iu/plaid-client';
import { useAuth } from '@/contexts/AuthContext';
import { notifyError, notifyWarning, humanizeError } from '@/utils/feedback';
import { isUnknownOutcome } from '@ui/lib/errors.js';
import { msg, t } from '@ui/lib/i18n.js';

// What every Bulk Edit panel shares: the run state machine and the toasts.

// The person's writerPolicy in `project`, the stamp on every value a Bulk
// Edit changes, as in the editor.
export const useWriter = (project) => {
  const { user } = useAuth();
  return useMemo(
    () =>
      writerPolicy(
        user?.id && isReviewed(project, user.id, { isAdmin: !!user.isAdmin }) ? user.id : null,
      ),
    [project, user],
  );
};

// One sentence per kind of thing an apply skips.
const SKIPPED = {
  value: msg('Skipped {n, plural, one {# value} other {# values}} changed since the preview.'),
  word: msg('Skipped {n, plural, one {# word} other {# words}} changed since the preview.'),
  'lexicon entry': msg(
    'Skipped {n, plural, one {# lexicon entry} other {# lexicon entries}} changed since the preview.',
  ),
  occurrence: msg(
    'Skipped {n, plural, one {# occurrence} other {# occurrences}} changed since the preview.',
  ),
};

// The sentence an apply's toast ends with when some of the preview's changes
// were skipped because their word, value or entry changed after the preview.
// `counts` is [[n, kind], ...], each kind a key of SKIPPED, with at most
// words and lexicon entries together. A leading space, or the empty string
// when all are zero.
export const skippedNote = (counts) => {
  const live = counts.filter(([n]) => n > 0);
  if (!live.length) return '';
  if (live.length === 1) {
    const [n, kind] = live[0];
    if (!SKIPPED[kind]) throw new Error(`skippedNote: unknown kind ${kind}`);
    return ` ${t(SKIPPED[kind], { n })}`;
  }
  const words = live.find(([, kind]) => kind === 'word')?.[0];
  const entries = live.find(([, kind]) => kind === 'lexicon entry')?.[0];
  if (live.length !== 2 || words == null || entries == null)
    throw new Error('skippedNote: only words and lexicon entries go together');
  return ` ${t(
    'Skipped {words, plural, one {# word} other {# words}} and {entries, plural, one {# lexicon entry} other {# lexicon entries}} changed since the preview.',
    { words, entries },
  )}`;
};

// The toasts for a run that stopped partway after something landed:
// `failed` is the runner's { docName, error } and `done` names what landed
// ("3 words in 1 document respelled"). The error as any failed apply shows
// it, then what was written before the stop, as Re-analyze says it.
// A document whose answer was lost may well have landed, so it is not called
// failed: Apply again counts it as sent if it did.
export const notifyStopped = (failed, done, skipped = '') => {
  notifyError(humanizeError(failed.error), t('Failed to apply'));
  const lost = isUnknownOutcome(failed.error);
  const name = failed.docName;
  const said = name
    ? lost
      ? t(
          '{done}. No answer for “{name}”, which may or may not be changed. The documents after it were not changed.',
          { done, name },
        )
      : t('{done} before “{name}” failed. The remaining documents were not changed.', {
          done,
          name,
        })
    : lost
      ? t('{done}. No answer for the lexicon entries, which may or may not be changed.', { done })
      : t('{done} before the lexicon entries failed.', { done });
  notifyWarning(`${said}${skipped}`, t('Stopped early'));
};

// ---- shared bits ----------------------------------------------------------------

// Per-run state: busy flag, progress line, when the run started (for its
// clock), and the plan + selection.
export const useRun = () => {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [startedAt, setStartedAt] = useState(null);
  const [plan, setPlan] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

  // `reset` drops the previous plan and selection up front, so a re-run with
  // different input never shows stale results under the progress line.
  //
  // The line is never blank while a run is on: it starts on what the run is
  // doing, and `fn`'s `onProgress(done, total)` moves it to the document it is
  // on (a preview reads them, an apply writes them). `onProgress(text)` says
  // a step that is not per document.
  const run = async (label, fn, { reset = false } = {}) => {
    if (busy) return null;
    const applying = label === 'Apply';
    setBusy(true);
    setStartedAt(Date.now());
    setProgress(applying ? t('Applying…') : t('Searching…'));
    if (reset) {
      setPlan(null);
      setSelected(new Set());
    }
    const onProgress = (done, total) =>
      setProgress(
        typeof done === 'string'
          ? done
          : applying
            ? t('Applying to document {done} of {total}…', { done, total })
            : t('Loading document {done} of {total}…', { done, total }),
      );
    try {
      return await fn(onProgress);
    } catch (err) {
      console.error(`${label}:`, err);
      notifyError(humanizeError(err), applying ? t('Failed to apply') : t('Failed to preview'));
      return null;
    } finally {
      setBusy(false);
      setProgress('');
      setStartedAt(null);
    }
  };

  const toggle = (id, on) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggleMany = (ids, on) =>
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });

  return {
    busy,
    progress,
    startedAt,
    plan,
    setPlan,
    selected,
    setSelected,
    run,
    toggle,
    toggleMany,
  };
};

// Before/after for one word: the word row, and (when the word has a morpheme
// chain of its own) the chain row beneath it, laid out on one grid so the
// two arrows line up, with the after column hugging the before column.
// Shared by the respell and field previews: `lines` is [{ label, cls, from,
// to }], where a line without `to` is context (the word a gloss sits under)
// rather than a change.
