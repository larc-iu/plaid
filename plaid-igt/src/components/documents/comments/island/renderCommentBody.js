// lit-html's window onto the app's one Markdown renderer (src/lib/markdown.js).
//
// `unsafeHTML` is safe here and only here: the string has already been through
// DOMPurify. React's equivalent wrapper is @/components/ui/markdown.

import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { markdownToSafeHtml } from '@/lib/markdown';

/** Render a comment body for the thread view. Empty in, empty out. */
export function renderCommentBody(body) {
  const html = markdownToSafeHtml(body);
  return html ? unsafeHTML(html) : '';
}
