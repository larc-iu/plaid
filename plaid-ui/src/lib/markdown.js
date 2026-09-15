// Markdown to safe HTML, for the whole app.
//
// One renderer and one dialect, wherever Markdown appears: comment bodies, a
// service's self-description, and the assistant's answers. Framework-agnostic
// on purpose — the comment thread is lit-html and the other two are React, so
// this returns a STRING and each side wraps it (`unsafeHTML` there,
// `dangerouslySetInnerHTML` here).
//
// The pipeline is marked -> DOMPurify. Sanitizing is MANDATORY, not
// belt-and-braces: marked passes raw HTML in its input straight through, and
// every caller renders the result as real markup. Two of the three inputs are
// not written by the person reading them (a service supplies its own summary,
// a model writes the assistant's answers), so this is the boundary that makes
// them safe to display.

import { marked } from 'marked';
import DOMPurify from 'dompurify';

// The allowlist IS the dialect: one place to look when asking "does X work in
// Markdown here". Deliberately generous about structure (GFM tables, headings,
// task lists) and strict about anything that reaches out of the page.
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
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    // GFM task lists render a disabled checkbox. Kept so a checklist still
    // looks like one; the attributes below are all it is allowed to carry.
    'input',
  ],
  // `dir` is allowed because the hook below writes it. A source that writes one
  // by hand keeps it, which is the escape hatch for the paragraph the
  // first-strong rule gets wrong.
  ALLOWED_ATTR: ['href', 'type', 'checked', 'disabled', 'align', 'dir'],
};

// Blocks that get `dir="auto"`, so each one picks its own direction from its
// own first strong character.
//
// Per BLOCK and not on the wrapper: a guideline is as likely to be English
// prose about an Arabic example as it is to be Arabic throughout, and a
// document-wide guess would lay one of the two out backwards. A list item
// carries it rather than the list, so the marker moves to the side its own
// text starts on.
//
// Not `pre`, and not `code`: a fenced block is source, and source reads left to
// right whatever is quoted inside it.
const AUTO_DIR_TAGS = new Set([
  'P',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'TABLE',
  'TD',
  'TH',
]);

let hooked = false;
function ensureHook() {
  if (hooked) return;
  hooked = true;
  // Links open in a new tab and cannot reach back through window.opener. The
  // editor routinely holds unsaved work, so following a link must never
  // navigate away from it.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (AUTO_DIR_TAGS.has(node.tagName) && !node.hasAttribute('dir')) {
      node.setAttribute('dir', 'auto');
    }
  });
}

marked.setOptions({
  // A single newline is a line break. People type comments the way they type
  // chat messages, not the way they write Markdown documents, and model output
  // is written the same way.
  breaks: true,
  gfm: true,
});

/**
 * Render Markdown to a sanitized HTML string.
 *
 * NOTE: no images. An `<img>` is a fetch to an arbitrary URL every time anyone
 * views the content, which leaks who is reading what — and for the two inputs
 * this app does not author (a service summary, a model's answer) it is also an
 * exfiltration channel, since the URL itself carries data. Markdown image
 * syntax renders as its alt text instead.
 *
 * Falls back to the raw text if anything throws, so content is never lost to a
 * rendering bug: the reader sees the source rather than an empty box.
 */
export function markdownToSafeHtml(text) {
  const source = String(text ?? '');
  if (!source.trim()) return '';
  try {
    ensureHook();
    return DOMPurify.sanitize(marked.parse(source), PURIFY_CONFIG);
  } catch (err) {
    console.error('Failed to render Markdown:', err);
    // Escape, so a failure cannot turn into the injection this exists to stop.
    return source.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }
}
