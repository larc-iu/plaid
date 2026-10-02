import { useState } from 'react';
import { notifyError, notifyWarning, humanizeError } from '@/utils/feedback';
import { isUnknownOutcome } from '@ui/lib/errors.js';
import { countOf } from '@ui/lib/plural.js';

// What every Bulk Edit panel shares: the run state machine, the scope
// badge classes, and the one count-and-noun helper (plaid-ui's, re-exported).
export { countOf };

// The sentence an apply's toast ends with when some of the preview's changes
// were skipped because their word, value or entry changed after the preview.
// `counts` is [[n, word, words?], ...]. The empty string when all are zero.
export const skippedNote = (counts) => {
  const parts = counts.filter(([n]) => n > 0).map(([n, word, words]) => countOf(n, word, words));
  if (!parts.length) return '';
  return ` Skipped ${parts.join(' and ')} changed since the preview.`;
};

// The toasts for a run that stopped partway after something landed:
// `failed` is the runner's { docName, error } and `done` names what landed
// ("3 words in 1 document respelled"). The error as any failed apply shows
// it, then what was written before the stop, as Re-analyze says it.
// A document whose answer was lost may well have landed, so it is not called
// failed: Apply again counts it as sent if it did.
export const notifyStopped = (failed, done, skipped = '') => {
  notifyError(humanizeError(failed.error), 'Failed to apply');
  const lost = isUnknownOutcome(failed.error);
  notifyWarning(
    failed.docName
      ? lost
        ? `${done}. No answer for “${failed.docName}”, which may or may not be changed. The documents after it were not changed.${skipped}`
        : `${done} before “${failed.docName}” failed. The remaining documents were not changed.${skipped}`
      : lost
        ? `${done}. No answer for the lexicon entries, which may or may not be changed.${skipped}`
        : `${done} before the lexicon entries failed.${skipped}`,
    'Stopped early',
  );
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
    setProgress(applying ? 'Applying…' : 'Searching…');
    if (reset) {
      setPlan(null);
      setSelected(new Set());
    }
    const onProgress = (done, total) =>
      setProgress(
        typeof done === 'string'
          ? done
          : applying
            ? `Applying to document ${done} of ${total}…`
            : `Loading document ${done} of ${total}…`,
      );
    try {
      return await fn(onProgress);
    } catch (err) {
      console.error(`${label}:`, err);
      notifyError(humanizeError(err), `Failed to ${label.toLowerCase()}`);
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
