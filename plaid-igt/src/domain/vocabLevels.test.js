import { describe, it, expect } from 'vitest';
import {
  levelQueries,
  buildRemoteLevels,
  buildLocalLevels,
  buildItemLevels,
  isLevelCompatible,
  tokenKindOf,
} from './vocabLevels.js';

const layerInfo = {
  primaryTokenLayer: { tokens: [{ id: 'w1' }, { id: 'w2' }] },
  morphemeTokenLayer: { tokens: [{ id: 'm1' }, { id: 'm2' }] },
};
const vocabs = {
  v1: {
    id: 'v1',
    vocabLinks: [
      { id: 'l1', tokens: ['w1'], vocabItem: { id: 'i-word' } },
      { id: 'l2', tokens: ['m1'], vocabItem: { id: 'i-morph' } },
      { id: 'l3', tokens: ['m2'], vocabItem: { id: 'i-both' } },
      { id: 'l4', tokens: ['w2'], vocabItem: { id: 'i-both' } },
      { id: 'l5', tokens: ['w1', 'w2'], vocabItem: { id: 'i-multi' } }, // multi-token: ignored
    ],
  },
};

describe('vocabLevels', () => {
  it('emits one grouped query per vocab keyed by the token layer role', () => {
    const qs = levelQueries(['v1', 'v2']);
    expect(qs).toHaveLength(2);
    expect(qs[0].return.group).toEqual(['?v', '?tl.config.plaid.role']);
    expect(qs[0].where[2]).toEqual(['token', '?t', { layer: '?tl' }]);
  });

  it("folds remote rows by role, ignoring other apps' roles", () => {
    const remote = buildRemoteLevels([
      {
        results: [
          ['a', 'word', 2],
          ['a', 'syntactic-word', 5],
          ['b', 'morpheme', 1],
        ],
      },
      { results: [['b', 'word', 1]] },
    ]);
    expect([...remote.get('a')]).toEqual(['word']);
    expect([...remote.get('b')].sort()).toEqual(['morpheme', 'word']);
  });

  it("derives local levels from the document's single-token links", () => {
    const local = buildLocalLevels(layerInfo, vocabs);
    expect([...local.get('i-word')]).toEqual(['word']);
    expect([...local.get('i-morph')]).toEqual(['morpheme']);
    expect(local.get('i-both').size).toBe(2);
    expect(local.has('i-multi')).toBe(false);
  });

  it('merges remote + local into word / morpheme / mixed / null', () => {
    const remote = buildRemoteLevels([
      {
        results: [
          ['i-word', 'morpheme', 1],
          ['i-remote', 'word', 3],
        ],
      },
    ]);
    const levels = buildItemLevels({ layerInfo, vocabularies: vocabs, remote });
    expect(levels.get('i-word')).toBe('mixed'); // word locally, morpheme elsewhere
    expect(levels.get('i-morph')).toBe('morpheme');
    expect(levels.get('i-both')).toBe('mixed');
    expect(levels.get('i-remote')).toBe('word');
    expect(levels.get('i-never')).toBeUndefined();
  });

  it('compatibility: null accepts either, a level accepts itself, mixed accepts nothing', () => {
    expect(isLevelCompatible(null, 'word')).toBe(true);
    expect(isLevelCompatible(undefined, 'morpheme')).toBe(true);
    expect(isLevelCompatible('word', 'word')).toBe(true);
    expect(isLevelCompatible('word', 'morpheme')).toBe(false);
    expect(isLevelCompatible('mixed', 'word')).toBe(false);
  });

  it('tokenKindOf tells words from morphemes', () => {
    expect(tokenKindOf(layerInfo, 'w1')).toBe('word');
    expect(tokenKindOf(layerInfo, 'm2')).toBe('morpheme');
    expect(tokenKindOf(layerInfo, 'zz')).toBeNull();
  });
});
