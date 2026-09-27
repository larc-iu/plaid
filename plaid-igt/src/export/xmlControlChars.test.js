// A character XML 1.0 forbids (a vertical tab from a Word paste, a control
// character, NUL, U+FFFE) in any value must not make the ELAN, FLEx or LIFT
// file ill-formed. The three writers share one escaper, and each output is
// parsed here by a conformant XML parser.
import { describe, expect, it } from 'vitest';
import { SaxesParser } from 'saxes';
import { buildEafDocument } from './elan.js';
import { buildFlextextDocument, xmlEscape } from './flextext.js';
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
