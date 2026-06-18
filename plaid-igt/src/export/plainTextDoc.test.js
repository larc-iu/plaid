import { describe, it, expect } from 'vitest';
import { sentenceTierLines, formatSentencePlain, serializeDocumentPlain } from './plainTextDoc.js';
import { makeFixtureDoc, makeSentence, FULL_SELECTION } from './testFixtures.js';

describe('sentenceTierLines', () => {
  it('emits forms, orthography, morph, word tiers and non-empty sentence fields in order', () => {
    const doc = makeFixtureDoc();
    const lines = sentenceTierLines(doc.sortedSentences[0], FULL_SELECTION);
    expect(lines.map((l) => l.label)).toEqual([null, 'Translit', 'Gloss', 'POS', 'Translation']);
    expect(lines[0].cells).toEqual(['perro=s', 'corren']); // enclitic joint
    expect(lines[1].cells).toEqual(['perros-translit', '']);
    expect(lines[2].cells).toEqual(['dog=PL', '']); // no morphemes → empty cell
    expect(lines[3].cells).toEqual(['NOUN', 'VERB']);
    expect(lines[4]).toEqual({ kind: 'free', label: 'Translation', text: 'The dogs run.' });
    // Note has an empty value → omitted entirely.
  });

  it('falls back to surface forms when segmentation is off', () => {
    const doc = makeFixtureDoc();
    const lines = sentenceTierLines(doc.sortedSentences[0], { ...FULL_SELECTION, segmentMorphemes: false });
    expect(lines[0].cells).toEqual(['perros', 'corren']);
  });

  it('handles empty selections and tokens without morphemes', () => {
    const s = makeSentence({ begin: 0, end: 1, tokens: [{ content: 'x', annotations: {}, morphemes: [] }] });
    const lines = sentenceTierLines(s, {});
    expect(lines).toEqual([{ kind: 'cells', label: null, cells: ['x'] }]);
  });
});

describe('formatSentencePlain', () => {
  it('pads columns by code points and labels free lines', () => {
    const s = makeSentence({
      begin: 0, end: 5,
      annotations: { Translation: { value: 'ok' } },
      tokens: [
        { content: '𝕒𝕒', annotations: {}, morphemes: [{ metadata: { form: '𝕒𝕒' }, annotations: { Gloss: { value: 'x' } } }] },
        { content: 'b', annotations: {}, morphemes: [{ metadata: { form: 'b' }, annotations: { Gloss: { value: 'yy' } } }] },
      ],
    });
    const out = formatSentencePlain(s, { morphFields: ['Gloss'], sentFields: ['Translation'] });
    expect(out.split('\n')).toEqual(['𝕒𝕒  b', 'x   yy', 'Translation: ok']);
  });
});

describe('serializeDocumentPlain', () => {
  it('emits header with metadata, numbered sentences, trailing newline', () => {
    const doc = makeFixtureDoc();
    const out = serializeDocumentPlain(doc, FULL_SELECTION);
    expect(out).toBe([
      'Test & Doc',
      'Source: Field notes',
      'Genre: narrative',
      '',
      '(1)',
      'perro=s          corren',
      'perros-translit',
      'dog=PL',
      'NOUN             VERB',
      'Translation: The dogs run.',
      '',
    ].join('\n'));
  });

  it('omits header and numbering when disabled', () => {
    const doc = makeFixtureDoc();
    const out = serializeDocumentPlain(doc, { ...FULL_SELECTION, includeHeader: false, numberSentences: false });
    expect(out.startsWith('perro=s')).toBe(true);
    expect(out).not.toContain('(1)');
  });

  it('handles a document with no sentences', () => {
    const out = serializeDocumentPlain({ document: { name: 'Empty' }, body: '', sortedSentences: [] }, FULL_SELECTION);
    expect(out).toBe('Empty\n');
  });

  it('prefixes a sentence with the covering alignment speaker (transcript style)', () => {
    const doc = makeFixtureDoc({
      alignmentTokens: [{ id: 'a1', begin: 0, end: 14, metadata: { speaker: 'Speaker 1' } }],
    });
    const out = serializeDocumentPlain(doc, { ...FULL_SELECTION, includeHeader: false });
    expect(out.startsWith('(1) Speaker 1\n')).toBe(true);
  });

  it('omits the speaker when none resolves or when speakers are disabled', () => {
    const doc = makeFixtureDoc({
      alignmentTokens: [{ id: 'a1', begin: 0, end: 14, metadata: { speaker: 'Speaker 1' } }],
    });
    expect(serializeDocumentPlain(makeFixtureDoc(), { ...FULL_SELECTION, includeHeader: false })
      .startsWith('(1)\n')).toBe(true);
    expect(serializeDocumentPlain(doc, { ...FULL_SELECTION, includeHeader: false, speakers: false })
      .startsWith('(1)\n')).toBe(true);
  });
});
