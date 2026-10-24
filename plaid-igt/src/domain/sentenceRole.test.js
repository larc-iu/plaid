import { describe, it, expect } from 'vitest';
import { proposeSentenceRole, withSentenceRoles } from './sentenceRole.js';
import { readSentenceRole } from './igtConfig.js';

describe('proposeSentenceRole', () => {
  it('reads the base name, whatever its case, spacing and language suffix', () => {
    expect(proposeSentenceRole('Translation')).toBe('translation');
    expect(proposeSentenceRole('Translation (en)')).toBe('translation');
    expect(proposeSentenceRole('Free translation')).toBe('translation');
    expect(proposeSentenceRole('Literal Translation')).toBe('literalTranslation');
    expect(proposeSentenceRole('literal_translation')).toBe('literalTranslation');
    expect(proposeSentenceRole('Note')).toBe('note');
    expect(proposeSentenceRole('Notes')).toBe('note');
    expect(proposeSentenceRole('Comment')).toBe('note');
  });

  it('proposes nothing for any other name', () => {
    for (const name of ['Traducción', 'Gloss', 'Speaker', 'Translations of it', '', null]) {
      expect(proposeSentenceRole(name)).toBeNull();
    }
  });
});

describe('withSentenceRoles', () => {
  it('keeps a stated role, none included, and proposes one only for a sentence field without', () => {
    expect(
      withSentenceRoles([
        { name: 'Translation', scope: 'Sentence' },
        { name: 'Translation', scope: 'Sentence', sentenceRole: null },
        { name: 'Libre', scope: 'Sentence', sentenceRole: 'translation' },
        { name: 'Translation', scope: 'Word' },
      ]),
    ).toEqual([
      { name: 'Translation', scope: 'Sentence', sentenceRole: 'translation' },
      { name: 'Translation', scope: 'Sentence', sentenceRole: null },
      { name: 'Libre', scope: 'Sentence', sentenceRole: 'translation' },
      { name: 'Translation', scope: 'Word' },
    ]);
  });
});

describe('readSentenceRole', () => {
  it('reads only a role it knows', () => {
    expect(readSentenceRole({ igt: { sentenceRole: 'note' } })).toBe('note');
    expect(readSentenceRole({ igt: { sentenceRole: 'Translation' } })).toBeNull();
    expect(readSentenceRole({ igt: {} })).toBeNull();
    expect(readSentenceRole(null)).toBeNull();
  });
});
