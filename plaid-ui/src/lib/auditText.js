// Server-written audit descriptions, made fit to read.
//
// Some of them name the row they touched: "Set editor config ud/dependency on
// layer 01a0971f-5cfd-…", "Create relation layer "Dependency Relations" in span
// layer 01a0971f-…". The id is for a log, not a reader. It identifies nothing
// they can see, it is most of the line's width, and on a project that has been
// reconciled for UD it is most of the feed.
//
// EVERY such clause goes, not only one at the end: "Create text in layer <id>
// for document <id> with 0 metadata keys" carries two of them in the middle and
// was the longest line in a fresh project's feed, three lines deep in the
// history rail.
//
// Descriptions go into an immutable audit log, so this has to happen at read
// time: fixing the writers would leave every row already stored as it is.
//
// What is left must still say what happened, and never stop on a joining
// word. The rules, in order:
//   1. "and <id>" and "into <id>" go whole: "Merge tokens <id> and <id>" reads
//      "Merge tokens", "Merge 3 vocab items into <id>" reads "Merge 3 vocab
//      items".
//   2. An id in brackets goes with them: "Delete project "X" (<id>)".
//   3. A clause that only places the row goes, preposition and all: "on layer
//      <id>", "in project <id>", "to span <id>". "of" is not one of them, since
//      it says what was changed: "Update body of text <id>" keeps "of text".
//   4. Any id left, after the noun it names, goes on its own: "Update guideline
//      <id>" reads "Update guideline".
//   5. A count of one is said in the singular where core wrote the plural:
//      "with 1 keys", "Merge 1 vocab items".
//
// A name the user typed is never touched: "Create document "Pear story in
// Manipuri" in project <id>" read "Create document "Pear story". Core writes a
// name between quotes exactly as typed, with no escaping, so a quote inside it
// is a bare quote too. The quoted part therefore runs from the first opening
// quote (", ' or “ after a space) to the LAST matching closing quote of the
// line, which also keeps "Copy "A" as "B"" in one piece, and the rules run
// only on what is before and after it.
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b';
const JOINED_ID = new RegExp(`\\s+(?:and|into)\\s+${ID}`, 'gi');
const BRACKETED_ID = new RegExp(`\\s*\\(${ID}\\)`, 'gi');
const UUID_CLAUSE = new RegExp(`\\s+\\b(?:on|in|to|from|for)\\b[\\w\\s-]*?${ID}`, 'gi');
const BARE_UUID = new RegExp(`\\s+${ID}`, 'gi');
const ONE_OF_MANY = /\b1 (metadata key|key|op|relation|vocab item)s\b/g;
const OPENING_QUOTE = /(^|\s)(["'\u201c])/;
const CLOSING_QUOTE = { '"': '"', "'": "'", '\u201c': '\u201d' };

const tidy = (part) =>
  part
    .replace(JOINED_ID, '')
    .replace(BRACKETED_ID, '')
    .replace(UUID_CLAUSE, '')
    .replace(BARE_UUID, '')
    .replace(ONE_OF_MANY, '1 $1');

export const readableDescription = (text) => {
  if (typeof text !== 'string') return text;
  const open = OPENING_QUOTE.exec(text);
  const start = open ? open.index + open[1].length : -1;
  const end = open ? text.lastIndexOf(CLOSING_QUOTE[open[2]]) : -1;
  if (end <= start) return tidy(text).trim();
  return (
    tidy(text.slice(0, start)) +
    text.slice(start, end + 1) +
    tidy(text.slice(end + 1))
  ).trim();
};

// What an operation's kind (the server's closed list, `?group-kind=`) is
// called on a History row. An operation with no kind names none.
const KIND_LABELS = {
  'assistant-plan': 'Assistant',
  'service-run': 'Automatic',
  import: 'Import',
  'bulk-edit': 'Bulk edit',
  'guess-adoption': 'Guess taken',
  repair: 'Repair',
  review: 'Review',
  job: 'Job',
};

export const operationKindLabel = (kind) => KIND_LABELS[kind] ?? null;
