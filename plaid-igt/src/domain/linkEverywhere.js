// "Link every ‹roa› in this text": the other tokens of a document that read
// the same as a linked one and are not linked to anything yet. A word matches
// by its surface content, a morpheme by the form it shows (its edited form
// when there is one). A token already linked, to this entry or another, is
// left out, so nothing anyone decided is relinked.

import { morphFormOf } from './igtExport.js';
import { extractAnalysis, isUnanalyzedWord } from './analysisMemory.js';

/**
 * @param {Array} sentences  the derived sentences (doc.sentences)
 * @param {'word'|'morpheme'} kind
 * @param {string} form   the form to match, exactly
 * @param {string} exceptId  the token the question is asked from
 * @returns {string[]} token ids, in document order
 */
export function sameFormUnlinked(sentences, kind, form, exceptId) {
  const out = [];
  // A word nobody has segmented and its one morpheme are the same thing to a
  // reader, so a link at either level speaks for both. Linking the other
  // level as well put two chips on one word saying different things.
  const oneMorph = (t) => (t.morphemes || []).length === 1;
  for (const s of sentences || []) {
    for (const t of s.tokens || []) {
      if (kind === 'word') {
        const takenBelow = oneMorph(t) && !!t.morphemes[0].vocabItem;
        if (t.id !== exceptId && !t.vocabItem && !takenBelow && t.content === form) out.push(t.id);
        continue;
      }
      const takenAbove = oneMorph(t) && !!t.vocabItem;
      if (takenAbove) continue;
      for (const m of t.morphemes || []) {
        if (m.id !== exceptId && !m.vocabItem && morphFormOf(m) === form) out.push(m.id);
      }
    }
  }
  return out;
}

/**
 * "Analyze every ‹again› in this text like this": the word a popover was opened
 * on (or the word its morpheme belongs to), what there is to copy from it, and
 * the other words spelled the same that nobody has analyzed. Only those: a word
 * with any segmentation, link or value of its own was somebody's decision.
 *
 * The analysis is `extractAnalysis`'s, so a word carrying nothing but machine
 * output nobody confirmed offers nothing, as it offers nothing to Auto-analyze.
 * A person asking for a copy makes it their work, and that must not be a way to
 * launder a guess.
 *
 * @param {Array} sentences  the derived sentences (doc.sentences)
 * @param {string} tokenId   a word id, or the id of one of a word's morphemes
 * @param {object|null} ignoredCfg  the project's ignored-tokens rule
 * @returns {{word: object, analysis: object, ids: string[]}|null}
 */
export function sameFormUnanalyzed(sentences, tokenId, ignoredCfg = null) {
  let word = null;
  for (const s of sentences || []) {
    word = (s.tokens || []).find(
      (t) => t.id === tokenId || (t.morphemes || []).some((m) => m.id === tokenId),
    );
    if (word) break;
  }
  const analysis = word && extractAnalysis(word);
  if (!analysis) return null;
  const ids = [];
  for (const s of sentences || []) {
    for (const t of s.tokens || []) {
      if (t.id !== word.id && t.content === word.content && isUnanalyzedWord(t, ignoredCfg)) {
        ids.push(t.id);
      }
    }
  }
  return ids.length ? { word, analysis, ids } : null;
}
