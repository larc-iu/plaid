// Which columns of a sentence's grid are the words of one multi-word token,
// and what that token is written as. The grid shows the syntactic words, one
// column each, and "del" (de + el) would otherwise look like two ordinary
// words. A thin bracket under their forms, labelled "del", says they are one
// written token (SentenceRow and TokenColumn draw it).

// What the label is estimated to need, per character, at the label's 12px.
// The same kind of estimate the column widths are made from (SentenceRow).
const LABEL_CHAR_WIDTH = 8;
// Room on either side of the label for a stretch of the bracket's line.
const LABEL_PADDING = 24;

/** The token's written form: its stored FORM, else its text in the document. */
const writtenForm = (entry) => {
  const stored = entry.word?.metadata?.form;
  return typeof stored === 'string' && stored !== '' ? stored : entry.wordForm;
};

/**
 * The multi-word tokens among a sentence's rows, each as the index of its
 * first word, the number of words it has, and its written form. A token with
 * one word is not one of them.
 */
export const multiWordTokens = (rows) => {
  const groups = [];
  let i = 0;
  while (i < rows.length) {
    const word = rows[i].word;
    let size = 1;
    if (word && rows[i].wordHasMultipleMorphemes) {
      while (i + size < rows.length && rows[i + size].word?.id === word.id) size += 1;
    }
    if (size > 1) groups.push({ start: i, size, form: writtenForm(rows[i]) });
    i += size;
  }
  return groups;
};

/**
 * Column widths widened so each multi-word token's label fits over its words.
 * Any width it needs goes to the token's last word. Returns the input array
 * when nothing needs widening.
 */
export const widenForLabels = (widths, groups, gap) => {
  let out = widths;
  for (const { start, size, form } of groups) {
    const span = bracketWidth(out, start, size, gap);
    const need = [...(form || '')].length * LABEL_CHAR_WIDTH + LABEL_PADDING;
    if (span >= need) continue;
    if (out === widths) out = [...widths];
    out[start + size - 1] += need - span;
  }
  return out;
};

/**
 * How wide a bracket over `size` columns from `start` is drawn: from the start
 * of the first word's content box to the end of the last's. Each column is
 * `widths[i]` wide including an inline padding of `gap` on both sides, and
 * the columns stand `gap` apart (SentenceRow.css, `.token-column`).
 */
export const bracketWidth = (widths, start, size, gap) => {
  let total = 0;
  for (let k = start; k < start + size; k++) total += widths[k];
  return total + gap * (size - 1) - 2 * gap;
};
