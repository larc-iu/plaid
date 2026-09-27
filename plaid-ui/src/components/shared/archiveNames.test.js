import { describe, it, expect } from 'vitest';
import { baseFileName, dedupeFileName, sanitizeFileName } from './archiveNames.js';

describe('baseFileName', () => {
  it("drops the format's extension or .txt, in any case", () => {
    expect(baseFileName('story.conllu', '.conllu')).toBe('story');
    expect(baseFileName('story.CONLLU', '.conllu')).toBe('story');
    expect(baseFileName('story.txt', '.umr')).toBe('story');
    expect(baseFileName('story.umr', '.umr')).toBe('story');
  });

  it('keeps any other extension, and a name that would be left empty', () => {
    expect(baseFileName('story.umr', '.conllu')).toBe('story.umr');
    expect(baseFileName('.umr', '.umr')).toBe('.umr');
    expect(baseFileName('a.b.umr', '.umr')).toBe('a.b');
  });

  it('reads the extension as text, not as a pattern', () => {
    expect(baseFileName('storyXumr', '.umr')).toBe('storyXumr');
  });
});

describe('sanitizeFileName', () => {
  it('replaces what a file name may not hold', () => {
    expect(sanitizeFileName('a/b:c*?d')).toBe('a_b_c_d');
    expect(sanitizeFileName('  ')).toBe('document');
    expect(sanitizeFileName('')).toBe('document');
    expect(sanitizeFileName(null)).toBe('document');
    expect(sanitizeFileName('نص')).toBe('نص');
  });
});

describe('dedupeFileName', () => {
  it('numbers a name already taken', () => {
    const used = new Set();
    expect(dedupeFileName('Story', '.umr', used)).toBe('Story.umr');
    expect(dedupeFileName('Story', '.umr', used)).toBe('Story (2).umr');
    expect(dedupeFileName('Story', '.umr', used)).toBe('Story (3).umr');
    expect(dedupeFileName('Story/1', '.umr', used)).toBe('Story_1.umr');
    expect([...used]).toEqual(['Story.umr', 'Story (2).umr', 'Story (3).umr', 'Story_1.umr']);
  });
});
