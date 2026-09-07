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

import { buildItemNumbers, buildSenseTree, homographOf } from '@igt/domain/vocabDictionary.js';
import { isPublished } from './publication.js';

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
export const readDictionary = (items) => {
  const list = items || [];
  const tree = buildSenseTree(list);
  const numbers = buildItemNumbers(list);

  // An item is on the spine if it is published or something under it is.
  // Walking up from each published item reaches every ancestor exactly once
  // more than it is already marked, so this stays linear in the tree's depth.
  const visible = new Set();
  for (const it of list) {
    if (!isPublished(it)) continue;
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
export const buildFormPages = (items, collator = new Intl.Collator()) => {
  const dict = readDictionary(items);
  const position = new Map((items || []).map((it, i) => [it.id, i]));

  const byForm = new Map();
  for (const r of dict.headwords) {
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
      headwords: roots.sort(byNumber).map((r) => nodeOf(r, dict)),
    }));
};

/**
 * The letter a form is filed under: its first character, without its
 * diacritics, uppercased. A form that starts with something uncased (a digit, a
 * glottal stop mark) is filed under that character as it stands. Digraphs get
 * no bucket of their own.
 */
export const indexLetter = (form) => {
  const first = [...String(form ?? '')][0];
  if (!first) return '';
  const bare = first.normalize('NFD').replace(/[\u0300-\u036f]/g, '') || first;
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
  const byLetter = new Map();
  for (const { form } of pages || []) {
    const letter = indexLetter(form);
    if (!byLetter.has(letter)) byLetter.set(letter, []);
    byLetter.get(letter).push(form);
  }
  return [...byLetter.entries()]
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([letter, forms]) => ({ letter, forms }));
};
