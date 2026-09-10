// "Link every ‹roa› in this text": the other tokens of a document that read
// the same as a linked one and are not linked to anything yet. A word matches
// by its surface content, a morpheme by the form it shows (its edited form
// when there is one). A token already linked, to this entry or another, is
// left out, so nothing anyone decided is relinked.

import { morphFormOf } from './igtExport.js';

/**
 * @param {Array} sentences  the derived sentences (doc.sentences)
 * @param {'word'|'morpheme'} kind
 * @param {string} form   the form to match, exactly
 * @param {string} exceptId  the token the question is asked from
 * @returns {string[]} token ids, in document order
 */
export function sameFormUnlinked(sentences, kind, form, exceptId) {
  const out = [];
  for (const s of sentences || []) {
    for (const t of s.tokens || []) {
      if (kind === 'word') {
        if (t.id !== exceptId && !t.vocabItem && t.content === form) out.push(t.id);
        continue;
      }
      for (const m of t.morphemes || []) {
        if (m.id !== exceptId && !m.vocabItem && morphFormOf(m) === form) out.push(m.id);
      }
    }
  }
  return out;
}
