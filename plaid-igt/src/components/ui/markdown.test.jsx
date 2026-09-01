// @vitest-environment jsdom
//
// jsdom, not the suite's default happy-dom: this asserts on what DOMPurify
// leaves behind, and happy-dom's parser does not reproduce the browser's tree
// for nested or invalid markup, which makes sanitized output look unsanitized.
import { describe, it, expect, afterEach } from 'vitest';
import { renderComponent, texts } from '@/test/renderComponent.jsx';
import { SafeMarkdown } from './markdown.jsx';

let mounted;
const show = async (md, className) => {
  mounted = await renderComponent(<SafeMarkdown className={className}>{md}</SafeMarkdown>);
  return mounted.container.querySelector('.md-body');
};

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe('SafeMarkdown', () => {
  it('renders Markdown as real markup', async () => {
    const out = await show('**bold** and a [link](https://example.com)');
    expect(out.querySelector('strong')?.textContent).toBe('bold');
    expect(out.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  });

  it('renders the GFM tables the assistant answers with', async () => {
    const out = await show('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(texts(out, 'th')).toEqual(['a', 'b']);
    expect(texts(out, 'td')).toEqual(['1', '2']);
  });

  it('renders the headings and lists a service summary uses', async () => {
    const out = await show('# Title\n\n- one\n- two');
    expect(out.querySelector('h1')?.textContent).toBe('Title');
    expect(texts(out, 'li')).toEqual(['one', 'two']);
  });

  it('sanitizes, so a service summary or a model answer cannot inject markup', async () => {
    // The property the old react-markdown call relied on (it did not render
    // raw HTML), now provided by DOMPurify instead.
    const out = await show('hi <script>alert(1)</script><img src=x onerror="alert(2)">');
    expect(out.querySelector('script')).toBeNull();
    expect(out.querySelector('img')).toBeNull();
    expect(out.innerHTML).not.toContain('onerror');
    expect(out.textContent).toContain('hi');
  });

  it('opens links in a new tab, severed from the opener', async () => {
    const a = (await show('[docs](https://example.com)')).querySelector('a');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('keeps the caller s classes alongside the shared defaults', async () => {
    // The assistant layers Tailwind Typography over `md-body`.
    const out = await show('hi', 'prose prose-sm');
    expect(out.className).toContain('md-body');
    expect(out.className).toContain('prose');
  });

  it('renders nothing for empty input rather than stale markup', async () => {
    const out = await show('   ');
    expect(out.innerHTML).toBe('');
  });
});
