// Our own CLDF export read back by our own importer: what the dataset can
// hold comes back where it was.
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readCldfDataset } from './readDataset.js';
import { buildCldfDocuments, customColumnChoices, groupingChoices } from './buildDocuments.js';
import { buildCldfDataset } from '../../export/cldf.js';
import { alignSurfaces } from '../align.js';
import { makeFixtureDoc, makeSentence } from '../../export/testFixtures.js';

const OPTIONS = {
  glossField: 'Gloss',
  glossScope: 'morpheme',
  translationField: 'Translation',
  commentField: 'Note',
  extras: { sentence: [], word: [], morpheme: [], orthographies: [] },
  speakers: false,
  dictionary: false,
};

const exportThenRead = (documents, options = OPTIONS) => {
  const { files } = buildCldfDataset({
    project: { name: 'Fieldwork' },
    languages: {
      object: { name: 'Spanish', glottocode: 'stan1288', iso639P3: 'spa' },
      meta: { name: 'English', iso639P3: 'eng' },
    },
    documents: documents.map((igtDoc) => ({ igtDoc })),
    vocabularies: [],
    options,
  });
  const dataset = readCldfDataset(
    zipSync(Object.fromEntries(files.map((f) => [f.path, strToU8(f.data)]))),
  );
  return { dataset, build: buildCldfDocuments(dataset) };
};

describe('document metadata', () => {
  it('keeps a field whose name has a space, an accent or a slash', () => {
    const names = ['Date', 'Título', 'Source/Ref', 'Genre (en)', 'naïve', 'Recording date'];
    const doc = makeFixtureDoc();
    doc.document.metadata = Object.fromEntries(names.map((n) => [n, `value of ${n}`]));
    const { build } = exportThenRead([doc]);
    expect(build.documents[0].metadata).toEqual(doc.document.metadata);
  });
});

describe('words that share a whitespace run', () => {
  // "medio-día": the tokenizer made two words of one run, and "medio" is
  // segmented as an underlying form that does not occur in the text.
  const body = 'el medio-día llega';
  const word = (id, begin, content, morphs) => ({
    id,
    begin,
    end: begin + content.length,
    content,
    metadata: {},
    annotations: {},
    orthographies: {},
    morphemes: morphs.map(([form, gloss], i) => ({
      id: `${id}m${i}`,
      begin,
      end: begin + content.length,
      content: form,
      metadata: { form },
      annotations: { Gloss: { value: gloss } },
    })),
  });
  const tokens = [
    word('w1', 0, 'el', [['el', 'the']]),
    word('w2', 3, 'medio', [
      ['mid', 'half'],
      ['o', 'M'],
    ]),
    word('w3', 9, 'día', [['día', 'day']]),
    word('w4', 13, 'llega', [['llega', 'arrives']]),
  ];
  const doc = () => ({
    document: { id: 'd1', name: 'Mediodía', mediaUrl: null, metadata: {} },
    body,
    sortedSentences: [
      makeSentence({
        begin: 0,
        end: body.length,
        tokens,
        pieces: [
          { type: 'token', ...tokens[0] },
          { type: 'gap', content: ' ' },
          { type: 'token', ...tokens[1] },
          { type: 'gap', content: '-' },
          { type: 'token', ...tokens[2] },
          { type: 'gap', content: ' ' },
          { type: 'token', ...tokens[3] },
        ],
      }),
    ],
    alignmentTokens: [],
  });

  it('come back as the same words with their own analyses', () => {
    const { build } = exportThenRead([doc()]);
    const [d] = build.documents;
    expect(d.body).toBe(body);
    expect(d.words.map((w) => d.body.slice(w.begin, w.end))).toEqual([
      'el',
      'medio',
      'día',
      'llega',
    ]);
    expect(d.words.map((w) => w.morphemes.map((m) => m.fields.Gloss))).toEqual([
      ['the'],
      ['half', 'M'],
      ['day'],
      ['arrives'],
    ]);
    expect(build.warnings.join('\n')).not.toMatch(/aligned by position/);
  });

  it('offer no field or grouping for the column that places them', () => {
    const { dataset } = exportThenRead([doc()]);
    expect(customColumnChoices(dataset).map((c) => c.name)).not.toContain('Surface_Word');
    expect(groupingChoices(dataset).map((c) => c.value)).not.toContain('Surface_Word');
  });

  it('are not written when Primary_Text comes from an orthography', () => {
    const d = doc();
    d.sortedSentences[0].tokens.forEach((t) => (t.orthographies = { Translit: t.content }));
    const { dataset } = exportThenRead([d], { ...OPTIONS, primaryText: 'Translit' });
    const columns = dataset.components.ExampleTable.columns.map((c) => c.name);
    expect(columns).not.toContain('Surface_Word');
  });
});

describe('an unanalyzed word that holds a joint', () => {
  // "nak-kinkin" and "o-" are words nobody segmented. Analyzed_Word gives each
  // as itself, and read as joints that made two morphemes, one of them empty.
  const body = 'nak-kinkin o- (tik-in) uno-dos';
  const plain = (id, begin, content, morphemes = []) => ({
    id,
    begin,
    end: begin + content.length,
    content,
    metadata: {},
    annotations: {},
    orthographies: {},
    morphemes,
  });
  const glossed = (id, begin, content) =>
    plain(id, begin, content, [
      {
        id: `${id}a`,
        content: 'uno',
        metadata: { form: 'uno' },
        annotations: { Gloss: { value: 'one' } },
      },
      {
        id: `${id}b`,
        content: 'dos',
        metadata: { form: 'dos' },
        annotations: { Gloss: { value: 'two' } },
      },
    ]);
  const tokens = [
    plain('w1', 0, 'nak-kinkin'),
    plain('w2', 11, 'o-'),
    plain('w3', 15, '(tik-in)'),
    glossed('w4', 24, 'uno-dos'),
  ];
  const doc = {
    document: { id: 'd1', name: 'Joints', mediaUrl: null, metadata: {} },
    body,
    sortedSentences: [makeSentence({ begin: 0, end: body.length, tokens })],
    alignmentTokens: [],
  };

  it('comes back unanalyzed, and an analysis with values comes back', () => {
    const { build } = exportThenRead([doc]);
    const [d] = build.documents;
    expect(d.words.map((w) => d.body.slice(w.begin, w.end))).toEqual([
      'nak-kinkin',
      'o-',
      '(tik-in)',
      'uno-dos',
    ]);
    expect(d.words.map((w) => w.morphemes.map((m) => m.form))).toEqual([
      [],
      [],
      [],
      ['uno', 'dos'],
    ]);
  });
});

describe('alignSurfaces', () => {
  it('matches a space in a surface against the line break the word spans', () => {
    const body = 'ab 1\n23 uno';
    expect(alignSurfaces(body, 0, body.length, ['ab', '1 23', 'uno']).spans).toEqual([
      { beginU16: 0, endU16: 2 },
      { beginU16: 3, endU16: 7 },
      { beginU16: 8, endU16: 11 },
    ]);
  });

  it('gives up when a word is not there in order, so the caller aligns by position', () => {
    expect(alignSurfaces('uno dos', 0, 7, ['dos', 'uno'])).toBeNull();
    expect(alignSurfaces('uno dos', 0, 3, ['uno', 'dos'])).toBeNull();
  });
});
