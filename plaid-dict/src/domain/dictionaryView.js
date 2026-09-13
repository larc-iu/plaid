// The dictionary as the reader sees it: pages, one per surface form, and the
// A to Z index over them.
//
// Visibility. An entry is shown if its own status is `published`. A headword
// that is not itself published still appears as the heading over its published
// senses, with its own gloss hidden: the tree's spine is structure, not
// content. A headword with nothing published under it is not a page.
//
// The tree, the numbering and the homograph order all come from plaid-igt's
// vocabDictionary.js, so an entry is called the same thing in both apps.

import { homographOf, lexiconView, STATUS_FIELD } from '@igt/domain/vocabDictionary.js';
import { foldDiacritics } from './collation.js';
import { searchableText } from './entryFields.js';
import { isPublished, statusKeyOf } from './publication.js';

/**
 * One entry and the senses under it, as the page draws them.
 *
 * @typedef {object} Node
 * @property {object} item      the vocab item
 * @property {string} number    its dotted number, '' for a lone headword
 * @property {boolean} shown    whether its own gloss and fields are shown
 * @property {Node[]} senses    its published senses, in sense order
 */

/**
 * The dictionary's published entries, keyed for the page builders.
 *
 * @returns {{
 *   tree: object,                  the whole sense tree (every item)
 *   numbers: Map<string, string>,  every item's dotted number
 *   visible: Set<string>,          items on a published entry's spine
 *   headwords: object[],           roots with something published under them
 * }}
 */
export const readDictionary = (items, statusKey = STATUS_FIELD) => {
  const list = items || [];
  const { tree, numbers } = lexiconView(list);

  // An item is on the spine if it is published or something under it is.
  // Walking up from each published item reaches every ancestor exactly once
  // more than it is already marked, so this stays linear in the tree's depth.
  const visible = new Set();
  for (const it of list) {
    if (!isPublished(it, statusKey)) continue;
    let cur = it.id;
    while (cur && !visible.has(cur)) {
      visible.add(cur);
      cur = tree.parentOf.get(cur);
    }
  }

  const headwords = tree.roots.filter((r) => visible.has(r.id));
  return { tree, numbers, visible, headwords };
};

const nodeOf = (item, { tree, numbers, visible }) => ({
  item,
  number: numbers.get(item.id) ?? '',
  shown: isPublished(item),
  senses: (tree.childrenOf.get(item.id) || [])
    .filter((c) => visible.has(c.id))
    .map((c) => nodeOf(c, { tree, numbers, visible })),
});

/**
 * The dictionary's pages, one per surface form, in collation order. Every
 * published headword spelled that way is on its page, in homograph order, as
 * OED and Wiktionary do.
 *
 * @returns {{form: string, headwords: Node[]}[]}
 */
export const buildFormPages = (items, collator = new Intl.Collator(), dict = null) => {
  const reading = dict ?? readDictionary(items);
  const position = new Map((items || []).map((it, i) => [it.id, i]));

  const byForm = new Map();
  for (const r of reading.headwords) {
    const form = r.form ?? '';
    if (!byForm.has(form)) byForm.set(form, []);
    byForm.get(form).push(r);
  }

  // Homograph order, the number plaid-igt stores on the entry; unnumbered
  // entries follow the numbered ones, in creation order.
  const byNumber = (a, b) => {
    const ha = homographOf(a);
    const hb = homographOf(b);
    if (ha != null && hb != null && ha !== hb) return ha - hb;
    if (ha != null && hb == null) return -1;
    if (ha == null && hb != null) return 1;
    return position.get(a.id) - position.get(b.id);
  };

  return [...byForm.entries()]
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([form, roots]) => ({
      form,
      // Folded here, not in the search: a five thousand headword dictionary
      // would otherwise fold five thousand forms on every keystroke.
      folded: foldDiacritics(form),
      headwords: roots.sort(byNumber).map((r) => nodeOf(r, reading)),
    }));
};

/**
 * The letter a form is filed under: its first character, without its diacritics,
 * uppercased. A form that starts with something uncased (a digit, a glottal stop
 * mark, the zero morph) is filed under that character as it stands. Digraphs get
 * no bucket of their own.
 *
 * The folding is compatibility (NFKD), not just canonical, so a form written
 * with a superscript letter is filed under the letter rather than in a bucket
 * of its own.
 */
export const indexLetter = (form) => {
  const first = [...String(form ?? '')][0];
  if (!first) return '';
  const bare = [...first.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')][0] || first;
  return bare.toUpperCase();
};

/**
 * The A to Z index over a dictionary's pages: one bucket per letter, in
 * collation order, each holding the forms filed under it in the order the
 * pages already stand.
 *
 * @returns {{letter: string, forms: string[]}[]}
 */
export const buildIndex = (pages, collator = new Intl.Collator()) => {
  // A dictionary with a stated alphabet heads its buckets with that alphabet's
  // own letters, n-graphs included; otherwise a first character does.
  const letterOf = collator.letterOf ?? indexLetter;
  const byLetter = new Map();
  for (const { form } of pages || []) {
    const letter = letterOf(form);
    if (!byLetter.has(letter)) byLetter.set(letter, []);
    byLetter.get(letter).push(form);
  }
  return [...byLetter.entries()]
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([letter, forms]) => ({ letter, forms }));
};

/**
 * Every published entry's searchable text, built once per dictionary: the form,
 * the part of speech, the glosses, the definitions and whatever else the
 * compiler wrote. Keyed by item id, so a keystroke is a lookup rather than a
 * re-read of the whole vocabulary.
 */
export const buildSearchIndex = (items, fields) => {
  const index = new Map();
  const key = statusKeyOf(fields);
  for (const it of items || []) {
    if (!isPublished(it, key)) continue;
    const text = searchableText(it, fields);
    // Both spellings, folded once: see searchPages for which one a query gets.
    index.set(it.id, { text, folded: foldDiacritics(text) });
  }
  return index;
};

/**
 * The pages a query leaves standing: a page matches when its form matches, or
 * when any entry on it does.
 *
 * A query that carries NO marks of its own is matched with the marks folded
 * away, so `oko` finds `ọkọ`. A query that carries marks is taken at its word,
 * so a reader who typed `ọkọ` is not also handed `oko`, which in Yoruba is a
 * different word. Typing the marks is how you ask for precision, and it is the
 * only signal available.
 *
 * Order: the forms that START with what was typed, exactly as typed, then the
 * ones that start with it once marks are folded, then the rest, each group
 * keeping the dictionary's own order.
 */
// An id the index does not hold: an entry that is not published, or a stale id.
const EMPTY_ENTRY = { text: '', folded: '' };

export const searchPages = (pages, query, index) => {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!q) return pages || [];
  const bare = foldDiacritics(q);
  // Folding changed nothing but case, so the reader typed no marks.
  const loose = bare === q;
  const textOf = (id) => index.get(id) || EMPTY_ENTRY;

  const hit = (node) => {
    const entry = textOf(node.item.id);
    return (
      entry.text.includes(q) || (loose && entry.folded.includes(bare)) || node.senses.some(hit)
    );
  };
  const formOf = (p) => (p.form || '').toLowerCase();
  const foldedOf = (p) => p.folded ?? foldDiacritics(p.form);
  const matched = (pages || []).filter(
    (p) => formOf(p).includes(q) || (loose && foldedOf(p).includes(bare)) || p.headwords.some(hit),
  );

  const exact = matched.filter((p) => formOf(p).startsWith(q));
  const folded = matched.filter(
    (p) => !formOf(p).startsWith(q) && loose && foldedOf(p).startsWith(bare),
  );
  const rest = matched.filter((p) => !exact.includes(p) && !folded.includes(p));
  return [...exact, ...folded, ...rest];
};
