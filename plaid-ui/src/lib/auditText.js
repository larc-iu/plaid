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
const UUID_CLAUSE =
  /\s+\b(?:on|in|to|from|of|for)\b[\w\s"'-]*?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export const readableDescription = (text) =>
  typeof text === 'string' ? text.replace(UUID_CLAUSE, '').trim() : text;
