import { describe, it, expect } from 'vitest';
import { ROLES } from '@larc-iu/plaid-client';
import {
  findBaselineTextLayer, findWordTokenLayer, findSentenceTokenLayer,
  findMorphemeTokenLayer, findAlignmentTokenLayer,
  readScope, readOrthographies, readIgnoredTokens, readDocumentMetadata,
  readInitialized, readVocabFields,
} from './igtConfig.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { buildRawDoc } from './test-helpers.js';

describe('igtConfig substrate finders (by shared role)', () => {
  const raw = buildRawDoc();
  const textLayers = raw.textLayers;
  const tokenLayers = textLayers[0].tokenLayers;

  it('finds the baseline text layer by role', () => {
    expect(findBaselineTextLayer(textLayers)?.id).toBe('tl-1');
  });

  it('finds sentence / word / morpheme / alignment token layers by role', () => {
    expect(findSentenceTokenLayer(tokenLayers)?.id).toBe('sentL');
    expect(findWordTokenLayer(tokenLayers)?.id).toBe('wordL');
    expect(findMorphemeTokenLayer(tokenLayers)?.id).toBe('morphL');
    expect(findAlignmentTokenLayer(tokenLayers)?.id).toBe('alignL');
  });

  it('returns null when no layer carries the role', () => {
    expect(findWordTokenLayer([{ config: { plaid: { role: ROLES.SENTENCE } } }])).toBeNull();
    expect(findBaselineTextLayer([])).toBeNull();
    expect(findBaselineTextLayer(undefined)).toBeNull();
  });
});

describe('igtConfig private readers (igt namespace only)', () => {
  it('reads its private config from the igt namespace', () => {
    expect(readScope({ igt: { scope: 'Word' } })).toBe('Word');
    expect(readOrthographies({ igt: { orthographies: [{ name: 'IPA' }] } })).toEqual([{ name: 'IPA' }]);
    expect(readIgnoredTokens({ igt: { ignoredTokens: { type: 'blacklist' } } })).toEqual({ type: 'blacklist' });
    expect(readDocumentMetadata({ igt: { documentMetadata: [{ name: 'Date' }] } })).toEqual([{ name: 'Date' }]);
    expect(readInitialized({ igt: { initialized: true } })).toBe(true);
    expect(readVocabFields({ igt: { fields: { Gloss: { inline: true } } } })).toEqual({ Gloss: { inline: true } });
  });

  it('does NOT fall back to the legacy plaid namespace (clean break)', () => {
    expect(readScope({ plaid: { scope: 'Word' } })).toBeNull();
    expect(readInitialized({ plaid: { initialized: true } })).toBe(false);
    expect(readOrthographies({ plaid: { orthographies: [{ name: 'IPA' }] } })).toBeNull();
  });

  it('returns null / false on missing config', () => {
    expect(readScope(undefined)).toBeNull();
    expect(readInitialized(undefined)).toBe(false);
    expect(readOrthographies(null)).toBeNull();
  });
});

describe('getIgtLayerInfo binds the new shape', () => {
  it('resolves all substrate layers and buckets spans by igt scope', () => {
    const info = getIgtLayerInfo(buildRawDoc());
    expect(info.primaryTextLayer?.id).toBe('tl-1');
    expect(info.primaryTokenLayer?.id).toBe('wordL');
    expect(info.sentenceTokenLayer?.id).toBe('sentL');
    expect(info.morphemeTokenLayer?.id).toBe('morphL');
    expect(info.alignmentTokenLayer?.id).toBe('alignL');
    expect(info.spanLayers.word.map(l => l.name)).toEqual(['POS']);
    expect(info.spanLayers.morpheme.map(l => l.name)).toEqual(['Gloss']);
    expect(info.spanLayers.sentence.map(l => l.name)).toEqual(['Translation']);
  });
});
