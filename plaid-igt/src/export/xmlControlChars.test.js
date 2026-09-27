// A character XML 1.0 forbids (a vertical tab from a Word paste, a control
// character, NUL, U+FFFE) in any value must not make the ELAN, FLEx or LIFT
// file ill-formed. The three writers share one escaper, and each output is
// parsed here by a conformant XML parser.
import { describe, expect, it } from 'vitest';
import { SaxesParser } from 'saxes';
import { buildEafDocument } from './elan.js';
import { buildFlextextDocument, countXmlDropped, xmlEscape } from './flextext.js';
import { runExport } from './runExport.js';
import { discoverExportLayers } from './exportLayers.js';
import { newPreset } from './presets.js';
import { buildLiftLexicon } from './lift.js';
import { makeFixtureDoc, FLEXTEXT_OPTIONS } from './testFixtures.js';

const wellFormed = (xml) => {
  const p = new SaxesParser({ xmlns: false });
  const errors = [];
  p.on('error', (e) => errors.push(e.message));
  try {
    p.write(xml).close();
  } catch (e) {
    errors.push(e.message);
  }
  return errors;
};

const BAD = {
  'vertical tab': 'a\u000Bb',
  'U+0001': 'a\u0001b',
  NUL: 'a\u0000b',
  'U+FFFE': 'a￾b',
  'U+FFFF': 'a￿b',
};

const doc = (v) => {
  const d = makeFixtureDoc();
  d.document.name = v;
  d.document.metadata = { Source: v };
  const s = d.sortedSentences[0];
  s.annotations.Translation = { value: v };
  s.tokens[0].morphemes[0].annotations.Gloss = { value: v };
  s.tokens[1].annotations.POS = { value: v };
  return d;
};

const ELAN_OPTIONS = {
  orthographies: [],
  wordFields: ['POS'],
  morphFields: ['Gloss'],
  sentFields: ['Translation'],
  segmentMorphemes: true,
  affixMarkers: true,
  perSpeaker: true,
};

describe('XML 1.0 forbidden characters', () => {
  it('xmlEscape drops them and keeps the characters XML allows', () => {
    expect(xmlEscape('a\u000B\u0000\u0001\u001F￾￿b')).toBe('ab');
    expect(xmlEscape('a\tb\nc\rd')).toBe('a\tb\nc\rd');
    expect(xmlEscape('𝄞 é')).toBe('𝄞 é');
  });

  for (const [label, v] of Object.entries(BAD)) {
    it(`a ${label} leaves every file well-formed`, () => {
      const eaf = buildEafDocument(doc(v), ELAN_OPTIONS, { exportedAt: '2026-01-01T00:00:00Z' });
      expect(wellFormed(eaf)).toEqual([]);
      expect(wellFormed(buildFlextextDocument([doc(v)], FLEXTEXT_OPTIONS))).toEqual([]);
      const lift = buildLiftLexicon({
        vocabularies: [
          {
            id: 'v1',
            name: 'L',
            items: [
              { id: 'i1', form: 'ktab' + v, metadata: { gloss: v, definition: v, pos: 'Noun' } },
            ],
          },
        ],
        options: { langs: { baseline: 'lez', analysis: 'en' } },
      });
      expect(wellFormed(lift.lift)).toEqual([]);
    });
  }
});

// The characters are dropped, and the export says so for the document or the
// lexicon they were in, since a gloss or a form did change.
describe('an export that drops forbidden characters says where', () => {
  it('countXmlDropped counts what xmlEscape dropped during one call', () => {
    const { out, dropped } = countXmlDropped(() => xmlEscape('a\u000Bb') + xmlEscape('c'));
    expect(out).toBe('abc');
    expect(dropped).toBe(1);
    expect(countXmlDropped(() => xmlEscape('clean')).dropped).toBe(0);
  });

  const role = (r) => ({ plaid: { role: r } });
  const PROJECT = {
    id: 'p1',
    name: 'P',
    textLayers: [
      {
        config: role('baseline'),
        tokenLayers: [
          { config: role('word'), spanLayers: [] },
          { config: role('sentence'), spanLayers: [] },
        ],
      },
    ],
    vocabs: [{ id: 'v1' }],
  };
  const rawDoc = (id, name, body) => ({
    id,
    name,
    textLayers: [
      {
        config: role('baseline'),
        text: { body },
        tokenLayers: [
          {
            config: role('word'),
            tokens: [{ id: 'w', begin: 0, end: [...body].length }],
            spanLayers: [],
          },
          {
            config: role('sentence'),
            tokens: [{ id: 's', begin: 0, end: [...body].length }],
            spanLayers: [],
          },
        ],
      },
    ],
  });
  const client = (body, form) => ({
    guidelines: { list: async () => [] },
    comments: { list: async () => [], listInVocab: async () => [] },
    users: { get: async (id) => ({ id }) },
    projects: { listDocuments: async () => [{ id: 'd1', name: 'Story' }] },
    documents: { get: async () => rawDoc('d1', 'Story', body) },
    vocabLayers: {
      get: async () => ({
        id: 'v1',
        name: 'Lexicon',
        config: {},
        items: [{ id: 'i1', form, metadata: { gloss: 'dog' } }],
        vocabLinks: [],
      }),
    },
  });

  for (const format of ['elan', 'flextext']) {
    it(`${format}: a document holding one is named in the warnings`, async () => {
      const result = await runExport({
        client: client('ab\u000Bc', 'perro'),
        project: PROJECT,
        preset: newPreset(format, discoverExportLayers(PROJECT), 'x'),
        scope: { type: 'document', id: 'd1' },
      });
      expect(result.warnings).toEqual(['"Story": invisible control characters left out']);
    });
  }

  it('flextext: a lexicon entry holding one is named in the warnings', async () => {
    const result = await runExport({
      client: client('abc', 'per\u0001ro'),
      project: PROJECT,
      preset: newPreset('flextext', discoverExportLayers(PROJECT), 'x'),
      scope: { type: 'document', id: 'd1' },
    });
    expect(result.warnings).toEqual([
      'Invisible control characters were left out of the .lift file.',
    ]);
  });

  it('a clean export has no such warning', async () => {
    const result = await runExport({
      client: client('abc', 'perro'),
      project: PROJECT,
      preset: newPreset('elan', discoverExportLayers(PROJECT), 'x'),
      scope: { type: 'document', id: 'd1' },
    });
    expect(result.warnings).toEqual([]);
  });
});
