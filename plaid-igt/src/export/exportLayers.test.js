import { describe, it, expect } from 'vitest';
import { discoverExportLayers, intersectSelection } from './exportLayers.js';

// Mirrors the substrate conventions: roles under config.plaid.role, scope
// under config.igt.scope, orthographies under config.igt.orthographies.
const role = (r) => ({ plaid: { role: r } });
const scoped = (name, scope) => ({ name, config: { igt: { scope } } });

const PROJECT = {
  textLayers: [{
    config: role('baseline'),
    tokenLayers: [
      {
        config: { ...role('word'), igt: { orthographies: [{ name: 'IPA' }, { name: 'Translit' }] } },
        spanLayers: [scoped('POS', 'Word'), scoped('Legacy', 'Token'), scoped('Stray', 'Morpheme')],
      },
      { config: role('sentence'), spanLayers: [scoped('Translation', 'Sentence')] },
      { config: role('morpheme'), spanLayers: [scoped('Gloss', 'Morpheme'), scoped('NoScope', null)] },
    ],
  }],
};

describe('discoverExportLayers', () => {
  it('buckets span layers by scope under the right substrate layers', () => {
    expect(discoverExportLayers(PROJECT)).toEqual({
      orthographies: ['IPA', 'Translit'],
      wordFields: ['POS', 'Legacy'],
      morphFields: ['Gloss'],
      sentFields: ['Translation'],
      hasMorphemes: true,
    });
  });

  it('returns empty buckets for a project with no IGT layers', () => {
    expect(discoverExportLayers({})).toEqual({
      orthographies: [], wordFields: [], morphFields: [], sentFields: [], hasMorphemes: false,
    });
  });
});

describe('intersectSelection', () => {
  it('drops stale names, keeps inventory order, preserves other keys', () => {
    const layers = discoverExportLayers(PROJECT);
    const out = intersectSelection({
      orthographies: ['Translit', 'Gone'],
      wordFields: ['Legacy', 'POS'],
      morphFields: ['Gone'],
      sentFields: ['Translation'],
      segmentMorphemes: false,
    }, layers);
    expect(out).toEqual({
      orthographies: ['Translit'],
      wordFields: ['POS', 'Legacy'],
      morphFields: [],
      sentFields: ['Translation'],
      segmentMorphemes: false,
    });
  });

  it('tolerates a missing selection', () => {
    const layers = discoverExportLayers({});
    expect(intersectSelection(null, layers)).toEqual({
      orthographies: [], wordFields: [], morphFields: [], sentFields: [],
    });
  });
});
