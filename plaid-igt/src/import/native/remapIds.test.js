import { describe, it, expect } from 'vitest';
import { remapIds } from './otherLayers.js';

describe('remapIds', () => {
  it('replaces an id alone or inside a string, at any depth, once', () => {
    const ids = new Map([
      ['A', 'B'],
      ['B', 'C'],
    ]);
    expect(remapIds({ x: ['A', 'layer:B', 'A B'], y: 3 }, ids)).toEqual({
      x: ['B', 'layer:C', 'B C'],
      y: 3,
    });
  });

  it('skips an empty id, so no string is touched by it', () => {
    expect(remapIds('abc', new Map([['', 'X']]))).toBe('abc');
    expect(
      remapIds(
        ['abc', 'A'],
        new Map([
          ['', 'X'],
          ['A', 'B'],
        ]),
      ),
    ).toEqual(['abc', 'B']);
  });
});
