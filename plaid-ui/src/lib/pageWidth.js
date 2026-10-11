// The width of the page under the app header, one per kind of page and the
// same in every app. Tailwind classes, written out whole so the class scanner
// finds them in this file.

/** A list or a table: the projects list, a document list, the admin tables. */
export const LIST_PAGE_WIDTH = 'max-w-[1320px]';

/** Settings and forms: a project's settings, a profile, an import form. */
export const FORM_PAGE_WIDTH = 'max-w-5xl';

/**
 * A document's side gutter, from the header band down through its tabs. At
 * phone width it is the 16px every other page keeps (`px-4`), so the crumb
 * does not jump between a project and its document.
 */
export const DOC_GUTTER = 'px-4 sm:px-6';
