import { describe, it, expect } from 'vitest';
import {
  changeHref,
  changeRef,
  changeTitle,
  collapseGroups,
  groupRows,
  planRows,
} from './planChanges.js';

const word = {
  kind: 'token',
  documentId: 'd1',
  documentName: 'Text 1',
  sentenceId: 's-1',
  sentence: 3,
  word: 2,
  morpheme: null,
  begin: 14,
  surface: 'gam',
};
const morpheme = { ...word, morpheme: 1, surface: 'ga' };
const sentence = { ...word, word: null, morpheme: null, begin: 0, surface: 'Ali-di gam akuna.' };
const entry = { kind: 'entry', vocabId: 'v1', vocabName: 'Lexicon', itemId: 'i1', form: 'gam' };

describe('changeHref', () => {
  it('opens the sentence, and the word within it', () => {
    expect(changeHref('p', word)).toBe(
      '#/projects/p/documents/d1?tab=analyze&focusSentence=s-1&focusWord=14',
    );
    expect(changeHref('p', sentence)).toBe(
      '#/projects/p/documents/d1?tab=analyze&focusSentence=s-1',
    );
    expect(changeHref('p', { kind: 'document', documentId: 'd1' })).toBe(
      '#/projects/p/documents/d1',
    );
    expect(changeHref('p', entry)).toBe('#/vocabularies/v1');
    expect(changeHref('p', null)).toBeNull();
    expect(changeHref('p', { kind: 'entry', vocabId: null })).toBeNull();
  });
});

describe('changeRef and changeTitle', () => {
  it('spell the place both ways', () => {
    expect(changeRef(word)).toBe('s3.w2');
    expect(changeRef(morpheme)).toBe('s3.w2.m1');
    expect(changeRef(sentence)).toBe('s3');
    expect(changeRef(entry)).toBe('');
    expect(changeTitle(morpheme)).toBe('Text 1, sentence 3, word 2, morpheme 1');
    expect(changeTitle(sentence)).toBe('Text 1, sentence 3');
    expect(changeTitle(entry)).toBe('Lexicon: gam');
  });
});

describe('planRows', () => {
  it('uses the located changes when they line up with the ops', () => {
    const plan = {
      ops: [{}, {}],
      labels: ['a', 'b'],
      changes: [
        { label: 'a', where: word, change: 'Gloss = "x"' },
        { label: 'b', where: null, change: null },
      ],
    };
    expect(planRows(plan)).toEqual([
      { index: 0, where: word, change: 'Gloss = "x"', label: 'a' },
      { index: 1, where: null, change: null, label: 'b' },
    ]);
  });

  it('falls back to the labels for a plan without located changes', () => {
    expect(planRows({ ops: [{}], labels: ['only a label'] })).toEqual([
      { index: 0, where: null, change: null, label: 'only a label' },
    ]);
    expect(planRows(null)).toEqual([]);
  });
});

describe('groupRows and collapseGroups', () => {
  const rows = [
    { index: 0, where: word, change: 'x', label: 'x' },
    { index: 1, where: entry, change: 'y', label: 'y' },
    {
      index: 2,
      where: { ...word, documentId: 'd2', documentName: 'Text 2' },
      change: 'z',
      label: 'z',
    },
    { index: 3, where: sentence, change: 'w', label: 'w' },
    { index: 4, where: null, change: null, label: 'New document "T"' },
  ];

  it('groups by document or lexicon, in order of first appearance', () => {
    const groups = groupRows(rows, 'p');
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.index)])).toEqual([
      ['Text 1', [0, 3]],
      ['Lexicon', [1]],
      ['Text 2', [2]],
      ['Other changes', [4]],
    ]);
    expect(groups[0].href).toBe('#/projects/p/documents/d1');
    expect(groups[1].href).toBe('#/vocabularies/v1');
    expect(groups[3].href).toBeNull();
  });

  it('keeps the first rows across groups when collapsed', () => {
    const groups = groupRows(rows, 'p');
    expect(collapseGroups(groups, 10)).toEqual({ groups, hidden: 0 });
    const { groups: cut, hidden } = collapseGroups(groups, 3);
    expect(hidden).toBe(2);
    expect(cut.map((g) => g.rows.map((r) => r.index))).toEqual([[0, 3], [1]]);
  });
});
