// A word's sole morpheme whose form spells the whole word follows the word's
// new spelling when a Baseline save changes the word (Luke, H17): the form a
// one-morpheme word was given as itself is the word, not a value of its own.
// A morpheme with no `form` key reads the word's text already and needs
// nothing. Every igt morpheme has its word's extent (mutations/morphemes.js).

import { cpSlice } from '@larc-iu/plaid-client';

const hasForm = (m) => !!m?.metadata && Object.prototype.hasOwnProperty.call(m.metadata, 'form');

// The real morphemes of each word, by the word's extent.
const morphemesByExtent = (info) => {
  const by = new Map();
  for (const m of info.morphemeTokenLayer?.tokens || []) {
    const key = `${m.begin}:${m.end}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(m);
  }
  return by;
};

/**
 * The words of `info` (layer info) with one morpheme whose stored form is the
 * word's text in `body`: word id to `{ morphemeId, form }`.
 */
export function soleForms(info, body) {
  const by = morphemesByExtent(info);
  const out = new Map();
  for (const w of info.primaryTokenLayer?.tokens || []) {
    const ms = by.get(`${w.begin}:${w.end}`);
    if (ms?.length !== 1 || !hasForm(ms[0])) continue;
    const text = cpSlice(body, w.begin, w.end);
    if (ms[0].metadata.form === text) out.set(w.id, { morphemeId: ms[0].id, form: text });
  }
  return out;
}

/**
 * The form writes that make each of `before` (`soleForms` of the document as
 * it was) follow its word on `info` and `body`, the document after the save:
 * `{ id, form }` for each word that reads otherwise now and still has that
 * one morpheme, spelled as before.
 */
export function followedForms(before, info, body) {
  if (!before?.size) return [];
  const by = morphemesByExtent(info);
  const out = [];
  for (const w of info.primaryTokenLayer?.tokens || []) {
    const was = before.get(w.id);
    if (!was) continue;
    const text = cpSlice(body, w.begin, w.end);
    if (text === was.form || text === '') continue;
    const ms = by.get(`${w.begin}:${w.end}`);
    if (ms?.length !== 1 || ms[0].id !== was.morphemeId || ms[0].metadata?.form !== was.form) {
      continue;
    }
    out.push({ id: was.morphemeId, form: text });
  }
  return out;
}
