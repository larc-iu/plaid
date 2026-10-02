import { describe, it, expect } from 'vitest';
import {
  anchorExcerpt,
  anchorName,
  describeAnchor,
  documentAnchor,
  documentEntityIds,
  quoted,
} from './commentAnchors.js';

// One rule for what every app's anchors quote.
describe('anchorExcerpt, anchorName and quoted', () => {
  it('puts a sentence on one line and cuts it at 60 code points', () => {
    expect(anchorExcerpt('  the\n cat\tsat ')).toBe('the cat sat');
    const long = 'a'.repeat(70);
    expect(anchorExcerpt(long)).toBe(`${'a'.repeat(59)}…`);
    expect(anchorExcerpt('a'.repeat(60))).toBe('a'.repeat(60));
    expect(anchorExcerpt(null)).toBe('');
  });

  it('cuts a name at 32 code points, never inside a character a person sees as one', () => {
    const fits = `${'a'.repeat(30)}😀😀`;
    expect(anchorName(fits)).toBe(fits);
    expect(anchorName(`${'b'.repeat(30)}e\u0301cc`)).toBe(`${'b'.repeat(30)}…`);
  });

  it('quotes an excerpt and leaves none empty', () => {
    expect(quoted('the cat')).toBe('“the cat”');
    expect(quoted('')).toBe('');
  });

  it('names the document', () => {
    expect(documentAnchor({ id: 'd', name: 'Story' })).toMatchObject({
      kind: 'document',
      label: 'Story',
      order: [-1],
    });
    expect(documentAnchor({ id: 'd' }).label).toBe('This document');
  });
});

// A document read with its layers, as every app reads one.
const raw = {
  id: 'd1',
  metadata: { note: { id: 'not-an-entity' } },
  textLayers: [
    {
      id: 'tl1',
      config: { igt: { id: 'not-an-entity-either' } },
      text: { id: 'x1', body: 'dogs bark' },
      tokenLayers: [
        {
          id: 'tok1',
          tokens: [
            { id: 'w1', begin: 0, end: 4, metadata: {} },
            { id: 'w2', begin: 5, end: 9 },
          ],
          spanLayers: [
            {
              id: 'sl1',
              spans: [{ id: 'g1', tokens: ['w1'], value: 'DOG.PL' }],
              relationLayers: [
                { id: 'rl1', relations: [{ id: 'r1', source: 'g1', target: 'g1' }] },
              ],
            },
          ],
          tokenLayers: [{ id: 'm1', tokens: [{ id: 'm-1', begin: 0, end: 3 }] }],
        },
      ],
    },
  ],
};

describe('documentEntityIds', () => {
  it('collects every entity a comment can be on, at any depth, and nothing from config or metadata', () => {
    const ids = documentEntityIds(raw);
    for (const id of ['d1', 'x1', 'w1', 'w2', 'g1', 'r1', 'm-1']) expect(ids.has(id)).toBe(true);
    expect(ids.has('not-an-entity')).toBe(false);
    expect(ids.has('not-an-entity-either')).toBe(false);
  });

  it('is empty for no document', () => {
    expect(documentEntityIds(null).size).toBe(0);
  });
});

describe('describeAnchor', () => {
  it('reads an anchor the index lacks but the document holds as on another layer', () => {
    const present = new Set(['g1']);
    const d = describeAnchor(new Map(), 'span', 'g1', 'DOG.PL', present);
    expect(d).toMatchObject({ kind: 'elsewhere', elsewhere: true, label: 'DOG.PL' });
    expect(d.outdated).toBeFalsy();
    expect(describeAnchor(new Map(), 'span', 'gone', 'X', present)).toMatchObject({
      outdated: true,
      label: 'X',
    });
  });
});
