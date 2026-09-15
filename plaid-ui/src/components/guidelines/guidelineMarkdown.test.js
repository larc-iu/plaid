// @vitest-environment jsdom
//
// jsdom, not the suite's default happy-dom, for the same reason as
// `lib/markdown.test.js`: half of this file asserts on what DOMPurify keeps,
// and happy-dom's HTML parser does not reproduce the browser's tree. Under it
// a heading comes back out of `markdownToSafeHtml` with its <h2> gone, which
// reads exactly like the dialect mismatch these tests exist to catch.
import { describe, it, expect } from 'vitest';
import { GUIDELINE_EXTENSIONS, parseMarkdown, roundTrip } from './guidelineMarkdown.js';
import { markdownToSafeHtml } from '../../lib/markdown.js';

// The two properties that keep an author and a reader looking at the same
// document. Both are cheap to hold and expensive to discover the loss of:
// nothing errors when they break, the text is just quietly different.
//
//   1. ROUND TRIP. Opening a guideline and saving it without typing is
//      markdown -> Tiptap -> markdown, and that has to be the identity.
//   2. DIALECT AGREEMENT. Everything the editor can produce survives
//      `lib/markdown.js`, whose DOMPurify allowlist drops what it does not
//      know without a word.

const SAMPLES = {
  heading: '## Glossing conventions',
  deepHeading: '#### A fourth-level heading',
  bold: 'Loanwords are **not** segmented.',
  italic: 'The *ergative* is marked.',
  boldItalic: 'This is ***never*** done.',
  strike: 'We ~~used to~~ gloss it that way.',
  inlineCode: 'Write `3SG`, never `3sg`.',
  link: 'See [the Leipzig rules](https://www.eva.mpg.de/lingua/).',
  bullets: '- first\n- second\n- third',
  ordered: '1. first\n2. second\n3. third',
  nestedList: '- outer\n  - inner\n- outer again',
  blockquote: '> Ruled on 2026-03-01.',
  codeBlock: '```\nkitab-ta\nbook-DAT\n```',
  codeBlockLang: '```python\nprint("hi")\n```',
  horizontalRule: '---',
  twoParagraphs: 'First paragraph.\n\nSecond paragraph.',
  // Language data goes in these. A guideline about the ergative will have the
  // ergative in it, and a normalization slip would rewrite the author's forms.
  ipa: 'The form is /kʰa˦˨tʰ/ with aspiration.',
  combiningDiacritic: 'Compare á with the precomposed á.',
  arabicRtl: 'The citation form is كتاب, glossed "book".',
  nonLatin: 'Лезги чӀал, ქართული, 日本語.',
  zeroMorph: 'The zero morph is written ∅.',
  table: [
    '| Proto | Lezgi | Gloss   |',
    '| ----- | ----- | ------- |',
    '| \\*k   | k     | "hand"  |',
    '| \\*q   | q     | "stone" |',
  ].join('\n'),
  mixed: [
    '## Translations',
    '',
    'Free translations are **idiomatic**, not literal.',
    '',
    '- Keep the punctuation the speaker used.',
    '- Do not gloss `∅` on the translation line.',
    '',
    '> Ruled on 2026-03-01.',
  ].join('\n'),
};

describe('a guideline survives being opened and saved', () => {
  for (const [name, markdown] of Object.entries(SAMPLES)) {
    it(`round-trips ${name} unchanged`, () => {
      expect(roundTrip(markdown).trim()).toBe(markdown.trim());
    });
  }

  it('round-trips an empty body, which is a guideline titled now and written later', () => {
    expect(roundTrip('').trim()).toBe('');
  });

  it('is stable on a second pass, so repeated saves cannot drift', () => {
    const once = roundTrip(SAMPLES.mixed);
    expect(roundTrip(once)).toBe(once);
  });
});

describe('the editor and the renderer describe one dialect', () => {
  // Every mark and node the configured schema can produce. Read off the
  // extensions rather than listed by hand, so adding one to
  // GUIDELINE_EXTENSIONS without checking the renderer fails here.
  const schemaNames = () => {
    const names = new Set();
    for (const ext of GUIDELINE_EXTENSIONS) {
      for (const child of ext.config?.addExtensions?.call?.({ options: ext.options }) ?? []) {
        names.add(child.name);
      }
      names.add(ext.name);
    }
    return names;
  };

  it('has no underline: markdown cannot write one and the renderer would strip it', () => {
    expect(schemaNames().has('underline')).toBe(false);
  });

  // The tags `lib/markdown.js` keeps. Restated here rather than imported
  // because the point is that two independent lists agree.
  const RENDERER_KEEPS = new Set([
    'P',
    'BR',
    'STRONG',
    'EM',
    'DEL',
    'CODE',
    'PRE',
    'A',
    'UL',
    'OL',
    'LI',
    'BLOCKQUOTE',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HR',
    'TABLE',
    'THEAD',
    'TBODY',
    'TR',
    'TH',
    'TD',
    'INPUT',
  ]);

  for (const [name, markdown] of Object.entries(SAMPLES)) {
    it(`renders ${name} with no tag the sanitizer drops`, () => {
      const html = markdownToSafeHtml(roundTrip(markdown));
      const tags = [...html.matchAll(/<([a-z][a-z0-9]*)\b/gi)].map((m) => m[1].toUpperCase());
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(RENDERER_KEEPS.has(tag)).toBe(true);
    });
  }

  it('keeps the words of every sample in the rendered output', () => {
    // The sanitizer dropping a tag takes its CONTENT with it for some tags, so
    // tag-checking alone would pass on an empty box. A distinctive word from
    // each sample has to come out the other side.
    const words = {
      bold: 'segmented',
      strike: 'gloss',
      link: 'Leipzig',
      codeBlock: 'kitab-ta',
      ipa: 'aspiration',
      arabicRtl: 'كتاب',
      zeroMorph: '∅',
      nonLatin: 'ქართული',
    };
    for (const [name, word] of Object.entries(words)) {
      expect(markdownToSafeHtml(roundTrip(SAMPLES[name]))).toContain(word);
    }
  });
});

describe('text outside the dialect is visible rather than lost', () => {
  it('keeps a pasted table, which without the table extension is dropped whole', () => {
    // Not a hypothetical: with StarterKit alone this input parses to an EMPTY
    // document. A linguist pasting a paradigm or a correspondence set would
    // watch it disappear with no error anywhere.
    const pasted = '| Proto | Lezgi | Gloss |\n| --- | --- |---|\n| *k | k | "hand" |';
    const once = roundTrip(pasted);
    for (const word of ['Proto', 'Lezgi', 'Gloss', '*k', 'hand']) {
      expect(once).toContain(word.replace('*', '\\*'));
    }
    // Normalized once (columns padded, a literal * escaped), then stable, so
    // saving twice does not keep rewriting the author's text.
    expect(roundTrip(once)).toBe(once);
  });

  it('keeps an image as its alt text, matching what the renderer does with one', () => {
    // `lib/markdown.js` drops images on purpose (an <img> leaks who is
    // reading). The editor agrees rather than letting someone insert one that
    // no reader will ever see.
    const doc = parseMarkdown('![a spectrogram](https://example.test/s.png)');
    expect(JSON.stringify(doc)).not.toContain('example.test');
  });
});
