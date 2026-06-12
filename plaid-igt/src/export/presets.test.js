import { describe, it, expect, vi } from 'vitest';
import {
  readExportPresets, writeExportPresets, newPreset, defaultFieldMap, formatExt,
} from './presets.js';

const LAYERS = {
  orthographies: ['IPA', 'Cyrillic Translit!'],
  wordFields: ['Word Gloss', 'POS'],
  morphFields: ['Gloss', 'Category', 'Etymology'],
  sentFields: ['Translation', 'Literal Translation', 'Note', 'Speaker'],
  hasMorphemes: true,
};

describe('defaultFieldMap', () => {
  it('inverts the FLEx import naming heuristically', () => {
    expect(defaultFieldMap(LAYERS)).toEqual({
      sentence: {
        Translation: 'gls',
        'Literal Translation': 'lit',
        Note: 'note',
        Speaker: 'note',
      },
      word: { 'Word Gloss': 'gls', POS: 'pos' },
      morpheme: { Gloss: 'gls', Category: 'msa' }, // Etymology unmapped → omitted
    });
  });
});

describe('newPreset', () => {
  it('builds a plaintext preset with everything selected', () => {
    const p = newPreset('plaintext', LAYERS, 'Handout');
    expect(p.name).toBe('Handout');
    expect(p.id).toMatch(/[0-9a-f-]{36}/);
    expect(p.format).toBe('plaintext');
    expect(p.options).toEqual({
      orthographies: LAYERS.orthographies,
      wordFields: LAYERS.wordFields,
      morphFields: LAYERS.morphFields,
      sentFields: LAYERS.sentFields,
      segmentMorphemes: true,
      numberSentences: true,
      includeHeader: true,
    });
  });

  it('builds a flextext preset with default langs and sanitized orthography tags', () => {
    const p = newPreset('flextext', LAYERS);
    expect(p.options.langs).toEqual({
      baseline: 'und',
      analysis: 'en',
      orthographies: { IPA: 'ipa', 'Cyrillic Translit!': 'cyrillictranslit' },
      fieldOverrides: {},
    });
    expect(p.options.citationForms).toBe(true);
    expect(p.options.fieldMap.morpheme.Gloss).toBe('gls');
  });
});

describe('preset persistence', () => {
  it('reads presets from project config and tolerates absence', () => {
    const presets = [{ id: 'x', name: 'A', format: 'plaintext', options: {} }];
    expect(readExportPresets({ config: { igt: { export: { presets } } } })).toEqual(presets);
    expect(readExportPresets({ config: { igt: { export: { presets: 'junk' } } } })).toEqual([]);
    expect(readExportPresets({})).toEqual([]);
    expect(readExportPresets(null)).toEqual([]);
  });

  it('writes the presets list under config.igt.export', async () => {
    const setConfig = vi.fn();
    await writeExportPresets({ projects: { setConfig } }, 'p1', [{ id: 'x' }]);
    expect(setConfig).toHaveBeenCalledWith('p1', 'igt', 'export', { presets: [{ id: 'x' }] });
  });
});

describe('formatExt', () => {
  it('maps formats to extensions with a txt fallback', () => {
    expect(formatExt('flextext')).toBe('flextext');
    expect(formatExt('plaintext')).toBe('txt');
    expect(formatExt('mystery')).toBe('txt');
  });
});
