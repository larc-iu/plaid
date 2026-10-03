import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { runExport } from './runExport.js';
import { discoverExportLayers } from './exportLayers.js';
import { EXPORT_FORMATS, newPreset } from './presets.js';
import { IgtDocument } from '../domain/IgtDocument.js';
import { bareIgnoredSentence } from '../domain/derive.js';
import { COPY_FORMATS, formatSentence } from '../domain/igtExport.js';
import { readIgnoredTokens } from '../domain/igtConfig.js';

// Exports and copies follow the Analyze grid (ruling, 2026-10-03): a word the
// ignored-tokens rule excludes is drawn with no values, so no export or copy
// format prints the values stored on it. The native archive is a lossless
// backup and keeps them.

const role = (r) => ({ plaid: { role: r } });
// "uh" is on the project's explicit ignore list, and was glossed before it was.
const IGNORED = { igt: { ignoredTokens: { type: 'blacklist', blacklist: ['uh'] } } };

const wordLayer = (extra = {}) => ({
  id: 'wordL',
  config: { ...role('word'), ...IGNORED },
  spanLayers: [{ id: 'glossL', name: 'Gloss', config: { igt: { scope: 'Word' } }, ...extra.gloss }],
  ...extra.layer,
});
const morphLayer = (extra = {}) => ({
  id: 'morphL',
  config: role('morpheme'),
  spanLayers: [
    { id: 'mglossL', name: 'Gloss', config: { igt: { scope: 'Morpheme' } }, ...extra.gloss },
  ],
  ...extra.layer,
});

const PROJECT = {
  id: 'p1',
  name: 'P',
  textLayers: [
    {
      id: 'tl',
      config: role('baseline'),
      tokenLayers: [
        wordLayer(),
        morphLayer(),
        { id: 'sentL', config: role('sentence'), spanLayers: [] },
      ],
    },
  ],
  vocabs: [],
};

// "uh dog": both words glossed, uh with FILLER on the word and FILLERM on a
// morpheme someone segmented before uh was ignored.
const RAW = {
  id: 'd1',
  name: 'Doc',
  textLayers: [
    {
      id: 'tl',
      config: role('baseline'),
      text: { id: 't1', body: 'uh dog' },
      tokenLayers: [
        wordLayer({
          layer: {
            tokens: [
              { id: 'w1', text: 't1', begin: 0, end: 2, metadata: {} },
              { id: 'w2', text: 't1', begin: 3, end: 6, metadata: {} },
            ],
          },
          gloss: {
            spans: [
              { id: 'g1', tokens: ['w1'], value: 'FILLER' },
              { id: 'g2', tokens: ['w2'], value: 'DOGWORD' },
            ],
          },
        }),
        morphLayer({
          layer: {
            tokens: [
              { id: 'm1', text: 't1', begin: 0, end: 2, precedence: 1, metadata: {} },
              { id: 'm2', text: 't1', begin: 3, end: 6, precedence: 1, metadata: {} },
            ],
          },
          gloss: {
            spans: [
              { id: 'mg1', tokens: ['m1'], value: 'FILLERM' },
              { id: 'mg2', tokens: ['m2'], value: 'DOGMORPH' },
            ],
          },
        }),
        {
          id: 'sentL',
          config: role('sentence'),
          tokens: [{ id: 's1', text: 't1', begin: 0, end: 6 }],
          spanLayers: [],
        },
      ],
    },
  ],
};

const client = {
  projects: { listDocuments: async () => [{ id: 'd1', name: 'Doc' }] },
  documents: { get: async () => JSON.parse(JSON.stringify(RAW)) },
  vocabLayers: { get: async (id) => ({ id, items: [] }) },
  comments: { list: async () => [], listInVocab: async () => [] },
  guidelines: { list: async () => [] },
};

const allText = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const files = zipped ? Object.values(unzipSync(bytes)) : [bytes];
  return files.map((b) => new TextDecoder().decode(b)).join('\n');
};

const exportAs = async (format) => {
  const preset = newPreset(format, discoverExportLayers(PROJECT), format);
  const result = await runExport({
    client,
    project: PROJECT,
    preset,
    scope: { type: 'document', id: 'd1' },
    fetchMedia: async () => {
      throw new Error('no media');
    },
  });
  return allText(result.blob);
};

describe('an ignored word in exports', () => {
  for (const { id } of EXPORT_FORMATS.filter((f) => f.id !== 'plaid-igt-json')) {
    it(`${id} carries none of its values, and the other word keeps its own`, async () => {
      const text = await exportAs(id);
      expect(text).not.toMatch(/FILLER/i);
      expect(text).toMatch(/DOGWORD|DOGMORPH/i);
    });
  }

  it('the native archive keeps them', async () => {
    const text = await exportAs('plaid-igt-json');
    expect(text).toMatch(/FILLERM/);
    expect(text).toMatch(/"FILLER"/);
  });
});

describe('an ignored word in a copy', () => {
  const doc = new IgtDocument({ raw: JSON.parse(JSON.stringify(RAW)), project: PROJECT });
  const [sentence] = doc.sentences;
  const cfg = readIgnoredTokens(doc.layerInfo.primaryTokenLayer.config);
  const fields = { morphFields: ['Gloss'], wordFields: ['Gloss'], sentFields: [] };

  for (const { id } of COPY_FORMATS) {
    it(`${id} carries none of its values`, () => {
      const text = formatSentence(bareIgnoredSentence(sentence, cfg), fields, id);
      expect(text).not.toMatch(/FILLER/i);
      expect(text).toMatch(/uh/);
      expect(text).toMatch(/DOGWORD|DOGMORPH/i);
    });
  }

  it('the editor keeps the values stored on it', () => {
    expect(sentence.tokens[0].annotations.Gloss?.value).toBe('FILLER');
  });
});
