// @vitest-environment jsdom
//
// jsdom, not the suite's default happy-dom: this file asserts on what DOMPurify
// strips, and happy-dom's HTML parser does not reproduce the browser's tree for
// nested/invalid markup (a <div> inside a <p>, for one), which made a sanitized
// result look unsanitized. Security behavior has to be tested against a
// faithful parser or not at all.
import { describe, it, expect, beforeEach } from 'vitest';
import { markdownToSafeHtml } from './markdown.js';

let host;

// Parse the sanitized OUTPUT back into a DOM and assert on that, rather than
// on the HTML string: what matters is the tree a browser would build.
const draw = (body) => {
  host.innerHTML = `<div class="out">${markdownToSafeHtml(body)}</div>`;
  return host.querySelector('.out');
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

describe('markdownToSafeHtml', () => {
  it('renders the inline marks people actually use in a comment', () => {
    const out = draw('**bold** and *italic* and `code` and ~~struck~~');
    expect(out.querySelector('strong')?.textContent).toBe('bold');
    expect(out.querySelector('em')?.textContent).toBe('italic');
    expect(out.querySelector('code')?.textContent).toBe('code');
    expect(out.querySelector('del')?.textContent).toBe('struck');
  });

  it('renders lists, quotes and fenced code', () => {
    expect(draw('- one\n- two').querySelectorAll('li')).toHaveLength(2);
    expect(draw('> quoted').querySelector('blockquote')).not.toBeNull();
    expect(draw('```\nx = 1\n```').querySelector('pre code')?.textContent.trim()).toBe('x = 1');
  });

  it('treats a single newline as a line break', () => {
    // People type comments like chat messages, not like Markdown documents.
    expect(draw('one\ntwo').querySelectorAll('br')).toHaveLength(1);
  });

  it('strips script tags and event handlers', () => {
    const out = draw('hello <script>alert(1)</script> <img src=x onerror="alert(2)">');
    expect(out.querySelector('script')).toBeNull();
    expect(out.innerHTML).not.toContain('onerror');
    expect(out.textContent).toContain('hello');
  });

  it('drops images entirely', () => {
    // An image is a fetch to an arbitrary URL every time anyone opens the
    // thread — a quiet way to learn who is reading what.
    expect(draw('![alt](https://example.com/tracker.png)').querySelector('img')).toBeNull();
  });

  it('refuses a javascript: link but keeps an ordinary one', () => {
    // The anchor survives, stripped of its href entirely — DOMPurify does not
    // rewrite the scheme, it removes the attribute.
    const bad = draw('[x](javascript:alert(1))').querySelector('a');
    expect(bad).not.toBeNull();
    expect(bad.hasAttribute('href')).toBe(false);

    const a = draw('[docs](https://example.com)').querySelector('a');
    expect(a.getAttribute('href')).toBe('https://example.com');
  });

  it('opens links in a new tab, severed from the opener', () => {
    // The editor routinely holds unsaved work; following a link must not
    // navigate away from it.
    const a = draw('[docs](https://example.com)').querySelector('a');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('leaves empty input alone', () => {
    expect(markdownToSafeHtml('')).toBe('');
    expect(markdownToSafeHtml(null)).toBe('');
    expect(markdownToSafeHtml('   ')).toBe('');
  });

  it('renders a GFM table, which the assistant relies on', () => {
    const out = draw('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(out.querySelectorAll('th')).toHaveLength(2);
    expect(out.querySelectorAll('td')).toHaveLength(2);
  });

  it('keeps a task-list checkbox, disabled', () => {
    const box = draw('- [x] done').querySelector('input[type="checkbox"]');
    expect(box).not.toBeNull();
    expect(box.hasAttribute('checked')).toBe(true);
  });

  it('renders headings, which a service summary uses', () => {
    expect(draw('# Title').querySelector('h1')?.textContent).toBe('Title');
  });

  it('does not let raw HTML in a comment become markup', () => {
    const out = draw('<b>not bold</b> <div onclick="x()">nope</div>');
    expect(out.querySelector('div[onclick]')).toBeNull();
    expect(out.innerHTML).not.toContain('onclick');
  });
});
