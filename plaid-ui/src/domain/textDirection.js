// Which way a document's data reads, and where that fact is written down.
//
// Plaid's substrate has no notion of direction, and for most of the world it
// does not need one: a string is a sequence of code points and the browser
// lays it out by the Unicode bidi algorithm. That is enough for one field at a
// time. It is not enough for a GRID. An interlinear block and a dependency
// tree both put words in columns, and the order of those columns is a layout
// decision no string can make on its own, because the container holding them
// also holds row labels written in the meta language.
//
// So direction is resolved once per document and handed down:
//
//   layout takes the document's direction, a value takes its own.
//
// A word column, a token column and a label column are laid out by the
// document's direction. A cell, an input, a name and a paragraph of Markdown
// carry `dir="auto"` and decide for themselves, which is what keeps an English
// gloss reading left to right inside a grid that runs right to left.
//
// This file imports nothing. `DocumentModel` reaches it by relative path, and
// plaid-ud's node suite resolves neither `@ui` nor the package.

/** The document's own text decides. The default, and what an unset document has. */
export const AUTO = 'auto';
export const LTR = 'ltr';
export const RTL = 'rtl';

/**
 * The document-metadata namespace an override is written under, mirroring the
 * reserved `config.plaid` namespace on layers and projects. Private: every
 * reader and writer of it is in this file, and `userMetadata` is how the rest
 * of the codebase knows it exists.
 *
 * Everything else in a document's metadata is a field somebody typed, under
 * the name they gave it. This one key is the app's, and its value is an object
 * rather than a string.
 */
const METADATA_NAMESPACE = 'plaid';

/**
 * A document's metadata as the FIELDS A PERSON ENTERED: the reserved namespace
 * removed.
 *
 * Every exporter that walks metadata generically has to come through here. All
 * three of them (CLDF, .flextext, plain text) write one column or one line per
 * key, and would otherwise put the reserved object in the file as the string
 * "[object Object]". The native archive is the exception and keeps metadata
 * whole, because a round trip has to give the document back exactly.
 */
export const userMetadata = (metadata) => {
  if (!metadata || !(METADATA_NAMESPACE in metadata)) return metadata || {};
  const out = { ...metadata };
  delete out[METADATA_NAMESPACE];
  return out;
};

// Every script written right to left, whether or not anyone is documenting one
// this week. Listing them is cheaper than being wrong about the one that turns
// up: a Plaid project is as likely to hold N'Ko or Adlam as Arabic, and the
// historical scripts cost a line each.
const RTL_SCRIPTS = [
  'Adlam',
  'Arabic',
  'Hanifi_Rohingya',
  'Hebrew',
  'Mandaic',
  'Mende_Kikakui',
  'Nko',
  'Old_Hungarian',
  'Phoenician',
  'Samaritan',
  'Syriac',
  'Thaana',
  'Yezidi',
];

const RTL_CLASS = RTL_SCRIPTS.map((s) => `\\p{Script=${s}}`).join('');

// A LETTER in one of those scripts, and a letter in any other. The lookahead
// is what limits each to letters: a script block also carries its own digits
// and punctuation, and Arabic-Indic digits are no more evidence of direction
// than Western ones are.
const RTL_LETTER = new RegExp(`(?=\\p{L})[${RTL_CLASS}]`, 'gu');
const LTR_LETTER = new RegExp(`(?=\\p{L})[^${RTL_CLASS}]`, 'gu');

// Count matches without building an array of them. A baseline text can be a
// whole transcript, and this runs on every document that opens.
const countMatches = (re, text) => {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  re.lastIndex = 0;
  return n;
};

/**
 * Which way `text` reads, by weight of the letters in it.
 *
 * Deliberately NOT the first-strong-character rule that `dir="auto"` applies.
 * First-strong is the right rule for one field, where there is nothing else to
 * go on. Over a whole document it is a coin toss on the opening word: one
 * Latin loanword or a speaker's name at the top of an Arabic transcript would
 * lay the entire text out backwards. Counting cannot be swung by one word.
 *
 * Text with no letters in it reads left to right, as does a tie.
 */
export const detectDirection = (text) => {
  const s = String(text ?? '');
  if (!s) return LTR;
  return countMatches(RTL_LETTER, s) > countMatches(LTR_LETTER, s) ? RTL : LTR;
};

/**
 * The direction a document has been SET to, or `AUTO` when it has not been set.
 * Anything unrecognized reads as `AUTO`, so a hand-edited or older document
 * falls back to detection rather than to a direction nobody chose.
 */
export const readTextDirection = (metadata) => {
  const v = metadata?.[METADATA_NAMESPACE]?.textDirection;
  return v === RTL || v === LTR ? v : AUTO;
};

/**
 * The direction to lay a document out in: what it was set to, or what its own
 * text says. Always `LTR` or `RTL`, never `AUTO`.
 */
export const resolveDirection = (metadata, sample) => {
  const set = readTextDirection(metadata);
  return set === AUTO ? detectDirection(sample) : set;
};

/**
 * The metadata patch that sets (or clears) the override.
 *
 * A document PATCH is shallow and replaces a nested namespace object wholesale,
 * so this restates the whole `plaid` object with whatever else was in it.
 * `AUTO` REMOVES the key rather than storing itself: a document set back to
 * automatic then reads the same as one that was never touched.
 */
export const textDirectionPatch = (metadata, value) => {
  const ns = { ...(metadata?.[METADATA_NAMESPACE] || {}) };
  if (value === LTR || value === RTL) ns.textDirection = value;
  else delete ns.textDirection;
  return { [METADATA_NAMESPACE]: ns };
};
