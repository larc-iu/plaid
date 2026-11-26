import { PROV_STATES } from '@larc-iu/plaid-client';
import { t, msg, listOf } from '@ui/lib/i18n.js';

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

// The legend's word for each provenance state.
const PROV_WORDS = {
  [PROV_STATES.HUMAN]: msg('a person’s'),
  [PROV_STATES.VERIFIED]: msg('confirmed'),
  [PROV_STATES.CONTRIBUTED]: msg('contributed'),
  [PROV_STATES.MACHINE]: msg('machine-made'),
};

/** What a value's tooltip says of whose it was or is. */
export const provTitle = (prov) => (prov && PROV_WORDS[prov] ? t(PROV_WORDS[prov]) : undefined);

// What the changes counted are, by kind (`kinds`, kind to count), in the
// nouns a job's report uses, in this order: "169 values, 169 morphemes and
// 151 links" (RP-3). Each noun reads before "changed" (REV-RPF-P-1).
// Each a counted phrase of its own, the phrases a list.
const KIND_WORDS = [
  ['values', msg('{n, plural, one {# value} other {# values}}')],
  ['morphemes', msg('{n, plural, one {# morpheme} other {# morphemes}}')],
  ['words', msg('{n, plural, one {# word} other {# words}}')],
  ['links', msg('{n, plural, one {# link} other {# links}}')],
  ['text', msg('{n, plural, one {# sentence text} other {# sentence texts}}')],
  ['entries', msg('{n, plural, one {# lexicon entry} other {# lexicon entries}}')],
  ['details', msg('{n, plural, one {# document detail} other {# document details}}')],
  ['other', msg('{n, plural, one {# other annotation} other {# other annotations}}')],
];
export const kindsLine = (kinds) =>
  listOf(KIND_WORDS.filter(([k]) => kinds[k] > 0).map(([k, words]) => t(words, { n: kinds[k] })));

// The line over an entry's changes: what it changed, each number with its
// noun, and how many of those replaced a person's value. "6 values and 5
// morphemes changed, 1 replaced a person’s value". Never a bare count of
// "changes", which a job's report counts in its own units: an analysis is
// one change there and its morphemes and values each a mark here
// (REV-RPF-P-1).
export const countLine = (kinds, replaced) =>
  t('{kinds} changed, {n, number} replaced a person’s value', {
    kinds: kindsLine(kinds),
    n: replaced,
  });
