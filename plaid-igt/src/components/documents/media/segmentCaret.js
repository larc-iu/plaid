import { cpLength } from '@larc-iu/plaid-client';

// Where the caret is in a transcript row's text, in code points of the
// segment's text as the row saves it (trimmed), when `el` is that row's text
// box. `id` names the segment when it must be that one. Null otherwise. A
// split cuts the text between the words nearest it.
export const caretInRow = (el, id = null) => {
  if (!el || el.tagName !== 'TEXTAREA') return null;
  const row = el.closest?.('[data-segment-id]');
  if (!row || row.hasAttribute('data-vad-proposal-row')) return null;
  if (id != null && row.getAttribute('data-segment-id') !== String(id)) return null;
  const value = el.value ?? '';
  const lead = cpLength(value) - cpLength(value.trimStart());
  return cpLength(value.slice(0, el.selectionStart ?? 0)) - lead;
};
