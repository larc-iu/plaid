// The conversation export writes names, titles and cell values into Markdown.
// Every one goes through the escapers in citations.js, and each is checked
// here by rendering the result with marked and counting what came out.
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { fencedBlock, linkLabel, markdownText, tableCell } from './citations.js';
import { conversationToMarkdown } from './exportMarkdown.js';
import { PLAIN_CITATIONS } from './plainCitations.js';

const decode = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
// GFM links a bare http URL wherever it appears, which is how a URL in text
// reads anyway. Anything else with an href was made by the value.
const hrefs = (html) =>
  [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).filter((h) => h !== 'http://evil.example');
const count = (html, tag) => (html.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;

const HOSTILE = [
  'x|y',
  'x\\|y',
  'x\\',
  'x\ny',
  'x\ry',
  'x\r\ny',
  'Doc] (http://evil.example) [x',
  'Doc\r[evil](http://evil.example)',
  'Doc\\]',
  '<javascript:alert(1)>',
  '<b>x</b>',
  // A bare URL is linked by GFM, which then shows the escapes inside it.
  'see http://x.org/a_b_(c)*d*',
  'HTTPS://x.org/a_b',
  'www.x.org/a_b',
  '<https://x.org/a_b>',
  // An entity reference would print as the character it names.
  'AT&amp;T &copy; &#65;',
];

describe('tableCell', () => {
  for (const v of HOSTILE) {
    it(`keeps ${JSON.stringify(v)} in one cell of one row`, () => {
      const html = marked.parse(`| a | b |\n|---|---|\n| ${tableCell(v)} | second |\n`);
      expect(count(html, 'tr')).toBe(2);
      expect(count(html, 'td')).toBe(2);
      expect(hrefs(html)).toEqual([]);
      const first = decode(html.match(/<td>([\s\S]*?)<\/td>/)[1]);
      expect(first).toBe(v.replace(/[\r\n]+/g, ' '));
    });
  }
});

describe('linkLabel and markdownText', () => {
  for (const v of HOSTILE) {
    it(`keep ${JSON.stringify(v)} as the text of one link`, () => {
      const html = marked.parse(`**[${linkLabel(`${v}, sentence 3`)}](http://plaid/#/doc)**`);
      expect(hrefs(html)).toEqual(['http://plaid/#/doc']);
      expect(decode(html).trim()).toBe(`${v.replace(/[\r\n]+/g, ' ')}, sentence 3`);
    });
    it(`keep ${JSON.stringify(v)} as the text of one heading`, () => {
      const html = marked.parse(`# ${markdownText(v)}\n\nbody\n`);
      expect(count(html, 'h1')).toBe(1);
      expect(hrefs(html)).toEqual([]);
      expect(decode(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1])).toBe(v.replace(/[\r\n]+/g, ' '));
    });
  }
});

describe('conversationToMarkdown', () => {
  it('writes a hostile title, project name and document name as text', () => {
    const name = 'Doc**\n\n# Injected heading\n[click](javascript:alert(1))';
    const key = '<cite doc="x" ref="s1"/>';
    const conv = {
      display: [
        { kind: 'assistant', text: key, citations: [{ key, documentName: name, sentence: 1 }] },
      ],
    };
    const md = conversationToMarkdown(
      conv,
      { title: 'T\n# Second title <javascript:alert(2)>', model: 'm\n# x' },
      { adapter: PLAIN_CITATIONS, origin: '', projectId: 'p', projectName: 'P\n[a](javascript:x)' },
    );
    const html = marked.parse(md);
    expect(count(html, 'h1')).toBe(1);
    expect(hrefs(html)).toEqual([]);
    expect(decode(html)).toContain(
      'Doc** # Injected heading [click](javascript:alert(1)), sentence 1',
    );
  });
});

describe('fencedBlock', () => {
  for (const v of ['(s1 / dog)', 'a ``` b', '````', '```\n# not a heading\n```']) {
    it(`keeps ${JSON.stringify(v)} verbatim in one block`, () => {
      const html = marked.parse(`${fencedBlock(v).join('\n')}\n\nafter\n`);
      expect(count(html, 'pre')).toBe(1);
      expect(count(html, 'h1')).toBe(0);
      expect(decode(html.match(/<code>([\s\S]*?)<\/code>/)[1])).toBe(`${v}\n`);
    });
  }
});
