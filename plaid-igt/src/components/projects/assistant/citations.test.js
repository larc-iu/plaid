import { describe, it, expect } from 'vitest';
import {
  CITE_RE,
  centeredScrollLeft,
  citePlain,
  citationFocus,
  citationHighlights,
  citationTitle,
  citationRows,
  linkifyCitations,
  sentenceHref,
} from './citations.js';

const matches = (s) => s.match(CITE_RE) || [];

describe('CITE_RE', () => {
  it('matches cite tags however the model closes them, and the older forms', () => {
    expect(matches('a <cite doc="Text 1" ref="s3"/> b')).toEqual(['<cite doc="Text 1" ref="s3"/>']);
    expect(matches('<cite ref="s3.w2.m1" doc="02 Адаз кицI">x</cite>')).toEqual([
      '<cite ref="s3.w2.m1" doc="02 Адаз кицI">',
    ]);
    expect(matches('<cite doc="A" ref="s1"></cite>')).toEqual(['<cite doc="A" ref="s1"></cite>']);
    expect(matches('old {{Text 1 s3}} and bare s4.w1.m2 here')).toEqual([
      '{{Text 1 s3}}',
      's4.w1.m2',
    ]);
  });

  it('leaves ordinary text alone', () => {
    expect(matches('nothing to cite in words2 or x.s1 or <b>bold</b>')).toEqual([]);
  });
});

describe('citePlain', () => {
  it('reads an unresolved citation back as the document and reference it names', () => {
    expect(citePlain('<cite doc="Text 1" ref="s3.w2"/>')).toBe('Text 1 s3.w2');
    expect(citePlain("<cite ref='s3' document=Notes>")).toBe('Notes s3');
    expect(citePlain('{{Nope s9}}')).toBe('Nope s9');
    expect(citePlain('s9')).toBe('s9');
  });
});

describe('citationTitle', () => {
  const base = { documentName: 'Text 1', sentence: 3 };
  const at = (...focus) => ({ ...base, focus });
  it('names the sentence, the word, and the morpheme when the citation points that deep', () => {
    expect(citationTitle(at())).toBe('Text 1, sentence 3');
    expect(citationTitle(at({ word: 2 }))).toBe('Text 1, sentence 3, word 2');
    expect(citationTitle(at({ word: 2, morpheme: 1 }))).toBe(
      'Text 1, sentence 3, word 2, morpheme 1',
    );
    expect(citationTitle(at({ word: 2 }, { word: 5, morpheme: 1 }))).toBe(
      'Text 1, sentence 3, words 2, 5',
    );
  });

  it('still names a conversation saved when a citation could point at only one word', () => {
    expect(citationFocus({ word: 2, morpheme: 1 })).toEqual([{ word: 2, morpheme: 1 }]);
    expect(citationTitle({ ...base, word: 2 })).toBe('Text 1, sentence 3, word 2');
    expect(citationFocus({})).toEqual([]);
  });
});

describe('citationHighlights', () => {
  it('marks a whole word, or the morphemes named inside it', () => {
    const h = citationHighlights({
      focus: [
        { word: 2, morpheme: 1 },
        { word: 2, morpheme: 3 },
        { word: 5, morpheme: null },
      ],
    });
    expect(h.get(2)).toEqual(new Set([1, 3]));
    expect(h.get(5)).toBe(true);
    expect(h.get(9)).toBeUndefined();
  });

  it('lets a word cited whole win over a morpheme inside it', () => {
    const h = citationHighlights({
      focus: [
        { word: 2, morpheme: 1 },
        { word: 2, morpheme: null },
      ],
    });
    expect(h.get(2)).toBe(true);
  });
});

describe('citationRows', () => {
  it('puts the surface first, then the tiers the service sent, dropping empty ones', () => {
    const c = {
      tiers: [
        { name: 'IPA', kind: 'orthography' },
        { name: 'Gloss', kind: 'word' },
        { name: 'Morphemes', kind: 'morphemes' },
        { name: 'POS', kind: 'morpheme' },
      ],
      words: [
        {
          index: 1,
          surface: 'Ali-di',
          seg: 'Ali-di',
          lines: [{ field: 'Gloss', value: 'Ali-ERG' }],
        },
        { index: 2, surface: 'gam', seg: null, lines: [] },
      ],
    };
    expect(citationRows(c)).toEqual([
      { label: '', kind: 'surface', cells: ['Ali-di', 'gam'] },
      { label: 'Gloss', kind: 'word', cells: ['Ali-ERG', ''] },
      { label: 'Morphemes', kind: 'morphemes', cells: ['Ali-di', ''] },
    ]);
  });
});

describe('linkifyCitations', () => {
  const c = {
    key: '<cite doc="Text 1" ref="s3"/>',
    documentId: 'd1',
    documentName: 'Text 1',
    sentenceId: 's-3',
    sentence: 3,
  };
  it('links resolved citations, flattens the rest, and reports each resolved one', () => {
    const seen = [];
    const out = linkifyCitations(
      'See <cite doc="Text 1" ref="s3"/> but not <cite doc="Text 1" ref="s99"/>.',
      new Map([[c.key, c]]),
      { projectId: 'p1', onCited: (m, cc) => seen.push(cc.sentence) },
    );
    expect(out).toBe(
      'See [Text 1, sentence 3](#/projects/p1/documents/d1?tab=analyze&focusSentence=s-3) but not Text 1 s99.',
    );
    expect(seen).toEqual([3]);
  });
});

describe('sentenceHref', () => {
  const c = {
    documentId: 'd1',
    sentenceId: 's-3',
    focus: [{ word: 2 }],
    words: [{ index: 2, begin: 41 }],
  };
  it('names the cited word in the URL, so the link lands on it in any tab', () => {
    expect(sentenceHref('', 'p1', c)).toBe(
      '#/projects/p1/documents/d1?tab=analyze&focusSentence=s-3&focusWord=41',
    );
    // Nothing cited, or a word whose offset was not sent: the sentence alone.
    expect(sentenceHref('', 'p1', { ...c, focus: [] })).toBe(
      '#/projects/p1/documents/d1?tab=analyze&focusSentence=s-3',
    );
    expect(sentenceHref('http://x/', 'p1', { ...c, words: [{ index: 2 }] })).toBe(
      'http://x/#/projects/p1/documents/d1?tab=analyze&focusSentence=s-3',
    );
  });
});

describe('centeredScrollLeft', () => {
  it('centres the cited span, without scrolling past either end', () => {
    expect(centeredScrollLeft(400, 500, 200, 900)).toBe(350);
    expect(centeredScrollLeft(0, 60, 200, 900)).toBe(0); // already at the left
    expect(centeredScrollLeft(850, 900, 200, 900)).toBe(700); // clamped to the end
  });
});
