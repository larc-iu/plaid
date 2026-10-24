import { describe, expect, it } from 'vitest';

import {
  analyzeNotice,
  analyzeParts,
  partsNotice,
  translateNotice,
  translateParts,
} from './analyzeNotice.js';

describe('analyzeNotice', () => {
  it('words an analyze step from its counts', () => {
    expect(analyzeNotice({ wordsWritten: 3, skipped: { protected: 0, unaligned: 0 } })).toEqual({
      level: 'success',
      title: 'Auto-analyze',
      message: 'Proposed analyses for 3 words. Shown in violet until confirmed.',
    });
  });

  it('says a step whose model was down wrote nothing (REV-W3-SVC F2)', () => {
    const notice = analyzeNotice({
      wordsWritten: 0,
      sentencesFailed: [{ sentenceId: 's1', reason: 'model error' }, { sentenceId: 's2' }],
      sentencesNotAsked: ['s3', 's4', 's5'],
    });
    expect(notice.level).toBe('warning');
    expect(notice.message).toBe(
      'Could not analyze 2 sentences, stopped early: the model did not answer (3 sentences not asked).',
    );
  });

  it('names the words the model gave no analysis (REV-W3-SVC F10)', () => {
    const notice = analyzeNotice({ wordsWritten: 0, skipped: { unaligned: 4 } });
    expect(notice).toEqual({
      level: 'warning',
      title: 'Auto-analyze',
      message: 'Got no analysis for 4 words.',
    });
    expect(analyzeParts({ wordsWritten: 2, skipped: { unaligned: 1 } }).parts).toEqual([
      'proposed analyses for 2 words',
      'got no analysis for 1 word',
    ]);
  });

  it('names a context field the run went without', () => {
    expect(analyzeParts({ translationFieldMissing: 'Free' }).parts).toEqual([
      'read no translations (no sentence field “Free”)',
    ]);
  });
});

describe('translateNotice', () => {
  it('words a translate step from its counts', () => {
    expect(translateNotice({ sentencesWritten: 1 }).message).toBe(
      'Proposed translations for 1 sentence. Shown in violet until confirmed.',
    );
    expect(translateParts({ sentencesNotAsked: ['s2'], glossFieldMissing: 'Gloss' }).parts).toEqual(
      [
        'stopped early: the model did not answer (1 sentence not asked)',
        'read no glosses (no morpheme field “Gloss”)',
      ],
    );
  });

  it('says nothing new when a run had nothing to report', () => {
    expect(partsNotice({ parts: [], wrote: false }).message).toBe('Nothing new to apply.');
    expect(translateNotice({}).level).toBe('warning');
  });
});
