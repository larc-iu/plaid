import { describe, it, expect } from 'vitest';
import { readLayerIds } from './documentReads.js';
import { buildRawDoc } from './test-helpers.js';

describe('readLayerIds', () => {
  // A project's layer tree has the same shape as a document's, without data.
  const project = () => {
    const p = buildRawDoc();
    // Another app's token layer on the baseline, with a field of its own on
    // the words, and another text layer with a token layer of its own.
    const [tl] = p.textLayers;
    tl.tokenLayers.push({ id: 'udL', config: {}, spanLayers: [] });
    tl.tokenLayers[1].spanLayers.push({ id: 'lemmaL', name: 'Lemma', config: {} });
    p.textLayers.push({
      id: 'tl-2',
      config: {},
      tokenLayers: [{ id: 'otherL', config: {}, spanLayers: [] }],
    });
    return p;
  };
  const sorted = (ids) => [...ids].sort();

  it("names this app's layers and every field of it by default", () => {
    expect(sorted(readLayerIds(project()))).toEqual(
      sorted(['tl-1', 'sentL', 'wordL', 'morphL', 'alignL', 'wsl-0', 'msl-0', 'ssl-0']),
    );
  });

  it('names no field, or the ones asked for', () => {
    expect(sorted(readLayerIds(project(), { spans: [] }))).toEqual(
      sorted(['tl-1', 'sentL', 'wordL', 'morphL', 'alignL']),
    );
    expect(sorted(readLayerIds(project(), { spans: ['msl-0'] }))).toEqual(
      sorted(['tl-1', 'sentL', 'wordL', 'morphL', 'alignL', 'msl-0']),
    );
  });

  it('names every token layer of every text layer when asked for all', () => {
    expect(sorted(readLayerIds(project(), { tokenLayers: 'all', spans: [] }))).toEqual(
      sorted(['tl-1', 'sentL', 'wordL', 'morphL', 'alignL', 'udL', 'otherL']),
    );
  });

  it('is null for a project with no baseline, which reads everything', () => {
    expect(readLayerIds({ textLayers: [{ id: 'x', config: {}, tokenLayers: [] }] })).toBeNull();
    expect(readLayerIds(null)).toBeNull();
  });
});
