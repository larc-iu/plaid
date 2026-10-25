import { describe, it, expect } from 'vitest';
import { htmlText } from './html.js';

describe('htmlText', () => {
  it('escapes the five characters HTML gives meaning to', () => {
    expect(htmlText(`<a href="x">Tom's & co</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom&#39;s &amp; co&lt;/a&gt;',
    );
  });

  it('escapes an ampersand once, before the entities it writes', () => {
    expect(htmlText('&lt;')).toBe('&amp;lt;');
  });

  it('writes nothing for no value and a string for a number', () => {
    expect(htmlText(undefined)).toBe('');
    expect(htmlText(null)).toBe('');
    expect(htmlText(3)).toBe('3');
  });
});
