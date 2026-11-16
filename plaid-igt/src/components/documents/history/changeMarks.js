import { PROV_STATES } from '@larc-iu/plaid-client';
import { andList, countOf } from '@ui/lib/plural.js';
import { PROV_WORDS } from '@/domain/historyChanges.js';

// The marks a value wears in History's view of what an entry changed: the
// provenance marks every app draws (plaid-ui's index.css, the Analyze grid's
// legend), on the old value and the new alike, so whose a value was reads as
// it reads in the grid. A person's value is plain.
const PROV_CLASS = {
  [PROV_STATES.MACHINE]: 'plaid-prov--machine',
  [PROV_STATES.CONTRIBUTED]: 'plaid-prov--contributed',
  [PROV_STATES.VERIFIED]:
    'underline decoration-[var(--plaid-machine-soft)] decoration-solid underline-offset-[3px]',
};
export const provClass = (prov) => PROV_CLASS[prov] ?? '';

/** What a value's tooltip says of whose it was or is. */
export const provTitle = (prov) => (prov ? PROV_WORDS[prov] : undefined);

// What the changes counted are, by kind (`kinds`, kind to count), in the
// nouns a job's report uses, in this order: "169 values, 169 morphemes and
// 151 links" (RP-3). Each noun reads before "changed" (REV-RPF-P-1).
const KIND_WORDS = [
  ['values', 'value', 'values'],
  ['morphemes', 'morpheme', 'morphemes'],
  ['words', 'word', 'words'],
  ['links', 'link', 'links'],
  ['text', 'sentence text', 'sentence texts'],
  ['entries', 'lexicon entry', 'lexicon entries'],
  ['details', 'document detail', 'document details'],
  ['other', 'other annotation', 'other annotations'],
];
export const kindsLine = (kinds) =>
  andList(
    KIND_WORDS.filter(([k]) => kinds[k] > 0).map(([k, one, many]) => countOf(kinds[k], one, many)),
  );

// The line over an entry's changes: what it changed, each number with its
// noun, and how many of those replaced a person's value. "6 values and 5
// morphemes changed, 1 replaced a person’s value". Never a bare count of
// "changes", which a job's report counts in its own units: an analysis is
// one change there and its morphemes and values each a mark here
// (REV-RPF-P-1).
export const countLine = (kinds, replaced) =>
  `${kindsLine(kinds)} changed, ${replaced.toLocaleString()} replaced a person’s value`;
