// What colour a scope wears.
//
// The visual language is that colour means scope or provenance. This is the
// scope half: a word is blue, a morpheme teal, a sentence green, and a fact
// about the whole document amber. Six screens each drew this table from
// memory, which is how one of them ends up a shade off from the rest and the
// colour stops meaning anything.
//
// The scope is written "Word" on a field and "word" in a query result, so
// both answer. An unknown scope wears nothing rather than a default colour:
// a badge with no colour reads as "no scope", a badge in the wrong one lies.
//
// The classes are spelled out rather than built from the tint, because
// Tailwind reads class names out of the source and cannot see one made from
// a variable. `SCOPE_TINTS` is what a test holds the two tables to.
export const SCOPE_TINTS = Object.freeze({
  word: 'blue',
  morpheme: 'teal',
  sentence: 'green',
  document: 'amber',
});

const BADGE = {
  word: 'border-transparent bg-blue-100 text-blue-700',
  morpheme: 'border-transparent bg-teal-100 text-teal-700',
  sentence: 'border-transparent bg-green-100 text-green-700',
  document: 'border-transparent bg-amber-100 text-amber-700',
};
const TEXT = {
  word: 'text-blue-700',
  morpheme: 'text-teal-700',
  sentence: 'text-green-700',
  document: 'text-amber-700',
};

const key = (scope) => String(scope ?? '').toLowerCase();

/** The badge classes for a scope, for a `<Badge variant="secondary">`. */
export const scopeBadgeClass = (scope) => BADGE[key(scope)] ?? '';

/** The same colour as text alone, where there is no badge to fill. */
export const scopeTextClass = (scope) => TEXT[key(scope)] ?? '';
