// Render a comment body as Markdown.
//
// `marked` returns an HTML STRING rather than a component tree, which is what
// makes it usable here at all: `react-markdown` is already a dependency for the
// assistant and for ServiceSummary, but it is React-only, and the comment
// thread is lit-html so it can be mounted in both the Analyze popover and the
// Comments tab.
//
// The pipeline is marked -> DOMPurify -> unsafeHTML. Sanitizing is MANDATORY,
// not belt-and-braces: marked passes raw HTML in its input straight through,
// and `unsafeHTML` is exactly what its name says.

import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// The allowlist, not `marked`'s options, is what defines the dialect — one
// place to look when asking "does X work in a comment".
//
// No images: an <img> in a comment is a fetch to an arbitrary URL every time
// anyone opens the thread, which is a quiet way to leak who is reading what.
// No headings above h3: a comment is not a document.
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'strong',
    'em',
    'del',
    'code',
    'pre',
    'a',
    'ul',
    'ol',
    'li',
    'blockquote',
    'h3',
    'h4',
    'hr',
  ],
  ALLOWED_ATTR: ['href'],
};

let hooked = false;
function ensureHook() {
  if (hooked) return;
  hooked = true;
  // Links open in a new tab and cannot reach back through window.opener. The
  // editor routinely holds unsaved work, so following a link in a comment must
  // never navigate away from it.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

marked.setOptions({
  // A single newline is a line break. People type comments the way they type
  // chat messages, not the way they write Markdown documents.
  breaks: true,
  gfm: true,
});

/**
 * Render `body` to something lit-html can place in a template.
 *
 * Falls back to the raw text if anything in the pipeline throws, so a comment
 * is never lost to a rendering bug — the reader sees the source instead of an
 * empty bubble.
 */
export function renderCommentBody(body) {
  const text = String(body ?? '');
  if (!text.trim()) return text;
  try {
    ensureHook();
    return unsafeHTML(DOMPurify.sanitize(marked.parse(text), PURIFY_CONFIG));
  } catch (err) {
    console.error('Failed to render comment body as Markdown:', err);
    return text;
  }
}
