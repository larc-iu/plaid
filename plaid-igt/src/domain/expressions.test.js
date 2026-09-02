import { describe, it, expect } from 'vitest';
import {
  bracketPieces,
  assignLanes,
  expressionMorphType,
  joinExpressionForm,
  collectExpressionLinks,
  isExpressionType,
} from './expressions.js';

describe('bracketPieces', () => {
  it('draws start, middles and end over an unbroken run', () => {
    expect(bracketPieces(6, [2, 3, 4])).toEqual([null, null, 'start', 'mid', 'end', null]);
  });

  it('draws a dotted pass-through on a skipped word', () => {
    expect(bracketPieces(5, [1, 3, 4])).toEqual([null, 'start', 'pass', 'mid', 'end']);
  });

  it('accepts members in any order', () => {
    expect(bracketPieces(4, [3, 0])).toEqual(['start', 'pass', 'pass', 'end']);
  });

  it('draws nothing for fewer than two members', () => {
    expect(bracketPieces(3, [1])).toEqual([null, null, null]);
    expect(bracketPieces(3, [])).toEqual([null, null, null]);
  });
});

describe('assignLanes', () => {
  it('keeps disjoint expressions on one lane', () => {
    expect(
      assignLanes([
        { first: 0, last: 1 },
        { first: 2, last: 4 },
      ]),
    ).toEqual([0, 0]);
  });

  it('gives an overlapping expression the next lane', () => {
    expect(
      assignLanes([
        { first: 0, last: 2 },
        { first: 1, last: 3 },
      ]),
    ).toEqual([0, 1]);
  });

  it('puts a nested shorter expression beneath the longer one it sits in', () => {
    expect(
      assignLanes([
        { first: 1, last: 2 },
        { first: 1, last: 5 },
      ]),
    ).toEqual([1, 0]);
  });

  it('reuses a lane once its expression has ended', () => {
    expect(
      assignLanes([
        { first: 0, last: 3 },
        { first: 1, last: 2 },
        { first: 4, last: 5 },
        { first: 3, last: 6 },
      ]),
    ).toEqual([0, 1, 0, 1]);
  });

  it('ranges collide even when the members do not', () => {
    // 0..3 skipping 1 and 2, and 1..2: the pass-through would run under the
    // second expression, so they cannot share a lane.
    expect(
      assignLanes([
        { first: 0, last: 3 },
        { first: 1, last: 2 },
      ]),
    ).toEqual([0, 1]);
  });
});

describe('a new expression entry', () => {
  it('is a phrase when the words are adjacent and a discontiguous phrase otherwise', () => {
    expect(expressionMorphType([2, 3, 4])).toBe('phrase');
    expect(expressionMorphType([4, 2, 3])).toBe('phrase');
    expect(expressionMorphType([1, 3])).toBe('discontiguous phrase');
  });

  it('takes the member surfaces joined by spaces', () => {
    expect(joinExpressionForm(['toma', 'el', 'pelo'])).toBe('toma el pelo');
    expect(joinExpressionForm([' echo', '', 'de ', 'menos'])).toBe('echo de menos');
  });

  it('recognises both phrase types', () => {
    expect(isExpressionType('phrase')).toBe(true);
    expect(isExpressionType('discontiguous phrase')).toBe(true);
    expect(isExpressionType('stem')).toBe(false);
    expect(isExpressionType(null)).toBe(false);
  });
});

describe('collectExpressionLinks', () => {
  it('keeps only links over two or more tokens, with their provenance', () => {
    const out = collectExpressionLinks({
      v1: {
        id: 'v1',
        name: 'Lexicon',
        vocabLinks: [
          { id: 'l1', tokens: ['w1'], vocabItem: { id: 'i1', form: 'one' } },
          {
            id: 'l2',
            tokens: ['w2', 'w3'],
            vocabItem: { id: 'i2', form: 'two three' },
            metadata: { prov: 'inferred', provSource: 'rule' },
          },
          { id: 'l3', tokens: ['w4', 'w5'] },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      linkId: 'l2',
      vocabId: 'v1',
      vocabName: 'Lexicon',
      tokenIds: ['w2', 'w3'],
      prov: 'machine',
    });
    expect(out[0].item.form).toBe('two three');
  });
});
