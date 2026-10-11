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

// A run in double quotes or guillemets, the way a reply quotes a form or a
// sentence from the data ("хъсан", «Ваз хъсан чида»). The marks pair up: a
// straight quote closes a straight one, a curly or low one its own partner.
// Single quotes are left alone, since an apostrophe looks like one and a gloss
// in single quotes is English.
const QUOTED_RE =
  /(["\u201c\u00ab\u201e])([^"\u201c\u201d\u00ab\u00bb\u201e\n]{1,200}?)(["\u201d\u00bb\u201c])/gu;
const CLOSER = { '"': '"', '\u201c': '\u201d', '\u00ab': '\u00bb', '\u201e': '\u201c' };
const LETTER_RE = /\p{L}/u;
// An opening mark at the very end of a text node, and its closer at the very
// start of the next: a quoted form set in bold or italic ("**хъсан**") is
// split across three nodes.
const OPEN_AT_END_RE = /["\u201c\u00ab\u201e]$/u;
const EMPHASIS = new Set(['STRONG', 'EM', 'B', 'I']);

// The bold or italic run that sits whole inside a pair of quotes. Bold alone is
// not a quotation: a model bolds a form and an English word the same way.
function setQuotedEmphasis(root) {
  for (const el of root.querySelectorAll('strong, em, b, i')) {
    if (!EMPHASIS.has(el.tagName) || el.closest('code, pre, a')) continue;
    const before = el.previousSibling;
    const after = el.nextSibling;
    if (before?.nodeType !== 3 || after?.nodeType !== 3) continue;
    const open = before.nodeValue.match(OPEN_AT_END_RE)?.[0];
    if (!open || !after.nodeValue.startsWith(CLOSER[open])) continue;
    if (LETTER_RE.test(el.textContent)) el.classList.add('font-text');
  }
}

// Sets what a reply quotes in the face for language data, and leaves the
// quote marks and the prose around them in the chrome's. Code, a fenced block
// and a link's label are not quotations.
function setQuotedForms(root) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const texts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest('code, pre, a')) texts.push(n);
  }
  for (const node of texts) {
    const value = node.nodeValue;
    const parts = [];
    let at = 0;
    for (const m of value.matchAll(QUOTED_RE)) {
      if (CLOSER[m[1]] !== m[3] || !LETTER_RE.test(m[2])) continue;
      const start = m.index + m[1].length;
      parts.push(doc.createTextNode(value.slice(at, start)));
      const span = doc.createElement('span');
      span.className = 'font-text';
      span.textContent = m[2];
      parts.push(span);
      at = start + m[2].length;
    }
    if (!parts.length) continue;
    parts.push(doc.createTextNode(value.slice(at)));
    node.replaceWith(...parts);
  }
}

/**
 * Render Markdown to a sanitized HTML string.
 *
 * `quotedForms` sets what the text quotes in double quotes or guillemets in
 * the face for language data (the assistant's replies, where the prose is
 * chrome and a quoted form is data), bold or italic inside the quotes too.
 * Bold or italic alone stays in the chrome's face.
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
export function markdownToSafeHtml(text, { quotedForms = false } = {}) {
  const source = String(text ?? '');
  if (!source.trim()) return '';
  try {
    ensureHook();
    if (!quotedForms) return DOMPurify.sanitize(marked.parse(source), PURIFY_CONFIG);
    const fragment = DOMPurify.sanitize(marked.parse(source), {
      ...PURIFY_CONFIG,
      RETURN_DOM_FRAGMENT: true,
    });
    setQuotedForms(fragment);
    setQuotedEmphasis(fragment);
    const box = fragment.ownerDocument.createElement('div');
    box.appendChild(fragment);
    return box.innerHTML;
  } catch (err) {
    console.error('Failed to render Markdown:', err);
    // Escape, so a failure cannot turn into the injection this exists to stop.
    return source.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }
}
