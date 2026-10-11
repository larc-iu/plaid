// The heading sizes every app shares, one class set per role. A heading picks
// its role here rather than a size of its own, so a page title in one app and
// in another, or a card title on Settings and on Details, are the same size.
//
// - page: the one title of a page (Projects, Admin), the same size as a
//   project's and a document's name in Charis above their tabs, so the top of
//   every page sits on one line height.
// - section: the heading under a project's tab strip, one per tab.
// - card: a Card's title, baked into CardTitle.
// - dialog: a dialog's title, baked into DialogTitle and AlertDialogTitle.
// - panel: a side panel's header (History, the assistant).
//
// No negative tracking: Source Sans 3 is spaced for display sizes as it is.
export const TYPE = {
  page: 'text-[1.75rem] font-bold leading-tight',
  section: 'text-xl font-semibold leading-tight',
  card: 'text-base font-semibold leading-snug',
  dialog: 'text-lg font-semibold leading-snug',
  panel: 'text-base font-semibold leading-tight',
};
