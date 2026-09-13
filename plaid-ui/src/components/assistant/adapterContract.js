// What the shared assistant screen needs from an app's adapter.
//
// The adapter is a plain object with no shape anywhere, so a member that was
// never added, or was renamed on one side, showed up as a blank where a
// document name should be, a plan row with no link, a citation rendered as raw
// markup, or a crash five components down. UD's `textName` was missing for a
// week and every plan card said "the text" instead of naming what it rewrites.
//
// Checked once, in development, where the adapter enters the shared half.
// Nothing is checked in a release build: the apps' own adapters are the only
// ones there are, and a thrown error in the panel would take the screen behind
// it down with it.

// Every member the shared half reads. An adapter may carry more (each app's own
// helpers build these out of each other) and that is not an error.
export const ADAPTER_MEMBERS = [
  // Which app's conversations these are. The record keys carry it and the
  // service advertises the same value in `extras.app`.
  'app',
  // How an operator starts an assistant, for the "none is online" line.
  'command',
  // The tab's opening line, and the examples under it.
  'intro',
  'examples',
  // What a plan is rewriting when it changes the text rather than an
  // annotation of it, in this app's words.
  'textName',
  // Where a conversation lives in this app.
  'convHref',
  // Citations: what one may look like, what it is called, where it links, how
  // it is drawn, and how it exports.
  'CITE_RE',
  'citationTitle',
  'citationHref',
  'citationToMarkdown',
  'ExampleCard',
  // A planned change: the heading it files under, and the place it names.
  'groupOf',
  'changePlace',
  // Reading one of this app's own links back, so a click can scroll the screen
  // behind the panel instead of navigating.
  'parseCitationHref',
];

export const missingFromAdapter = (adapter) =>
  adapter ? ADAPTER_MEMBERS.filter((k) => adapter[k] == null) : ADAPTER_MEMBERS;

export const assertAdapter = (adapter) => {
  const missing = missingFromAdapter(adapter);
  if (missing.length) throw new Error(`The assistant adapter is missing: ${missing.join(', ')}.`);
};
