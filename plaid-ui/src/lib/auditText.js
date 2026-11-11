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
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b';
const JOINED_ID = new RegExp(`\\s+(?:and|into)\\s+${ID}`, 'gi');
const BRACKETED_ID = new RegExp(`\\s*\\(${ID}\\)`, 'gi');
const UUID_CLAUSE = new RegExp(`\\s+\\b(?:on|in|to|from|for)\\b[\\w\\s"'-]*?${ID}`, 'gi');
const BARE_UUID = new RegExp(`\\s+${ID}`, 'gi');
const ONE_OF_MANY = /\b1 (metadata key|key|op|relation|vocab item)s\b/g;

export const readableDescription = (text) =>
  typeof text === 'string'
    ? text
        .replace(JOINED_ID, '')
        .replace(BRACKETED_ID, '')
        .replace(UUID_CLAUSE, '')
        .replace(BARE_UUID, '')
        .replace(ONE_OF_MANY, '1 $1')
        .trim()
    : text;

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
};

export const operationKindLabel = (kind) => KIND_LABELS[kind] ?? null;
