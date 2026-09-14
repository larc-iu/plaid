// The project page's content tabs, which ride in `?tab=`.
//
// Settings and Export are not here: they are path-backed, because a settings
// section and a preset's editor are pages of their own.

// Bulk Edit, Validation and Activity are maintainers-only. The Assistant is
// open to everyone, since it acts under the reader's own permissions.
const CONTENT_TABS = ['documents', 'search', 'bulk', 'validate', 'activity', 'assistant'];

const MAINTAINER_TABS = new Set(['bulk', 'validate', 'activity']);

/**
 * The tabs this reader has. The NARROWED list is what goes to `useTabParam`:
 * that is what makes a reader's `?tab=bulk` drop out of the address instead of
 * sitting there naming a tab that is not on screen. Correcting it at render
 * time instead left the URL saying one thing and the page showing another.
 */
export const contentTabsFor = (canManage) =>
  canManage ? CONTENT_TABS : CONTENT_TABS.filter((t) => !MAINTAINER_TABS.has(t));

// The spellings a person types from reading the tab bar, mapped onto the slugs
// this group uses. `?tab=validation` used to render Documents.
// Export and Settings are deliberately NOT here: aliasing `?tab=export` onto a
// tab would send someone somewhere other than the page they named.
export const TAB_ALIASES = {
  validation: 'validate',
  'bulk-edit': 'bulk',
  bulkedit: 'bulk',
};
