import { useState } from 'react';
import { notifyError, humanizeError } from '@/utils/feedback';

// What every Bulk Edit panel shares: the run state machine, the scope
// badge classes, and the one pluralizer.
export const plural = (n, word, words = `${word}s`) =>
  `${n.toLocaleString()} ${n === 1 ? word : words}`;

// ---- shared bits ----------------------------------------------------------------

// Per-run state: busy flag, progress line, and the plan + selection.
export const useRun = () => {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [plan, setPlan] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

  // `reset` drops the previous plan and selection up front, so a re-run with
  // different input never shows stale results under the progress line.
  const run = async (label, fn, { reset = false } = {}) => {
    if (busy) return null;
    setBusy(true);
    setProgress('');
    if (reset) {
      setPlan(null);
      setSelected(new Set());
    }
    try {
      return await fn((done, total) => setProgress(`Loading document ${done} of ${total}…`));
    } catch (err) {
      console.error(`${label}:`, err);
      notifyError(humanizeError(err, `${label} failed.`), label);
      return null;
    } finally {
      setBusy(false);
      setProgress('');
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

  return { busy, progress, plan, setPlan, selected, setSelected, run, toggle, toggleMany };
};

// Before/after for one word: the word row, and (when the word has a morpheme
// chain of its own) the chain row beneath it, laid out on one grid so the
// two arrows line up, with the after column hugging the before column.
// Shared by the respell and field previews: `lines` is [{ label, cls, from,
// to }], where a line without `to` is context (the word a gloss sits under)
// rather than a change.
export const SCOPE_CLS = {
  word: 'text-blue-700',
  morpheme: 'text-teal-700',
  sentence: 'text-green-700',
};
