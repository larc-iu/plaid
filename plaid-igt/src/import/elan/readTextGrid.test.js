import { describe, it, expect } from 'vitest';
import { readTextGrid, readTextGridFile } from './readTextGrid.js';
import { EafError } from './readEaf.js';
import { compareSchemas, suggestRoles, validateRoles, ROLES } from './schema.js';
import { buildElanDocuments } from './buildDocuments.js';
import { buildTextGrid } from '../../export/textgrid.js';
import { makeFixtureDoc, makeAlignmentToken } from '../../export/testFixtures.js';

// A long-format TextGrid from tiers of [begin, end, text] (gaps filled).
const longGrid = (xmax, tiers) => {
  const out = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    '',
    'xmin = 0 ',
    `xmax = ${xmax} `,
    'tiers? <exists> ',
    `size = ${tiers.length} `,
    'item []: ',
  ];
  tiers.forEach(([name, ivs], t) => {
    const filled = [];
    let at = 0;
    for (const [b, e, text] of ivs) {
      if (b > at) filled.push([at, b, '']);
      filled.push([b, e, text]);
      at = e;
    }
    if (at < xmax) filled.push([at, xmax, '']);
    out.push(
      `    item [${t + 1}]:`,
      '        class = "IntervalTier" ',
      `        name = "${name}" `,
      '        xmin = 0 ',
      `        xmax = ${xmax} `,
      `        intervals: size = ${filled.length} `,
    );
    filled.forEach(([b, e, text], i) =>
      out.push(
        `        intervals [${i + 1}]:`,
        `            xmin = ${b} `,
        `            xmax = ${e} `,
        `            text = "${text.replace(/"/g, '""')}" `,
      ),
    );
  });
  return out.join('\n');
};

// Transcription, then a translation on the same intervals.
const FIELD = longGrid(5, [
  [
    'transcription',
    [
      [0.5, 2, 'los perros corren'],
      [2.5, 4, 'el gato "duerme"'],
    ],
  ],
  [
    'translation',
    [
      [0.5, 2, 'the dogs run'],
      [2.5, 4, 'the cat sleeps'],
    ],
  ],
]);

const build = (grids) => {
  const parsed = grids.map(([text, name]) => readTextGrid(text, name));
  const { nodes } = compareSchemas(parsed);
  const roles = suggestRoles(nodes);
  return { parsed, nodes, roles, build: buildElanDocuments(parsed, nodes, roles) };
};

describe('readTextGrid', () => {
  it('hangs a tier on the same intervals under the tier before it', () => {
    const tg = readTextGrid(FIELD, 'Story.TextGrid');
    expect(tg.documentName).toBe('Story');
    expect(tg.tiers.map((t) => [t.id, t.parentRef])).toEqual([
      ['transcription', null],
      ['translation', 'transcription'],
    ]);
    expect(tg.tiers[0].annotations.map((a) => [a.beginMs, a.endMs, a.value])).toEqual([
      [500, 2000, 'los perros corren'],
      [2500, 4000, 'el gato "duerme"'],
    ]);
    const [first] = tg.tiers[1].annotations;
    expect([first.kind, first.ref, first.value]).toEqual([
      'ref',
      tg.tiers[0].annotations[0].id,
      'the dogs run',
    ]);
  });

  it('imports as sentences with their translation and times', () => {
    const { nodes, roles, build: built } = build([[FIELD, 'Story.TextGrid']]);
    const roleOf = (name) => roles[nodes.find((n) => n.baseName === name).key];
    expect(roleOf('transcription')).toBe(ROLES.UTTERANCE);
    expect(roleOf('translation')).toBe(ROLES.SENTENCE_FIELD);
    expect(validateRoles(nodes, roles)).toEqual([]);
    const [doc] = built.documents;
    expect(doc.body).toBe('los perros corren\nel gato "duerme"');
    expect(doc.sentences.map((s) => s.fields.translation)).toEqual([
      'the dogs run',
      'the cat sleeps',
    ]);
    expect(doc.alignments.map((a) => [a.timeBegin, a.timeEnd])).toEqual([
      [0.5, 2],
      [2.5, 4],
    ]);
  });

  it('hangs a tier inside another under it, keeping its times, as a forced aligner writes them', () => {
    const tg = readTextGrid(
      longGrid(3, [
        ['utterance', [[0.5, 2.5, 'los perros']]],
        [
          'words',
          [
            [0.5, 1, 'los'],
            [1.2, 2.5, 'perros'],
          ],
        ],
        [
          'phones',
          [
            [0.5, 0.7, 'l'],
            [0.7, 1, 'os'],
          ],
        ],
      ]),
      'a.TextGrid',
    );
    expect(
      tg.tiers.map((t) => [t.id, t.parentRef, tg.linguisticTypes[t.typeRef].constraint]),
    ).toEqual([
      ['utterance', null, null],
      ['words', 'utterance', 'Included_In'],
      ['phones', 'words', 'Included_In'],
    ]);
    expect(tg.tiers[1].annotations.map((a) => [a.kind, a.beginMs, a.endMs])).toEqual([
      ['alignable', 500, 1000],
      ['alignable', 1200, 2500],
    ]);
  });

  it('imports the word tier of an aligner as the words, once the review says so', () => {
    const grid = longGrid(3, [
      ['utterance', [[0.5, 2.5, 'los perros']]],
      [
        'words',
        [
          [0.5, 1, 'los'],
          [1.2, 2.5, 'perros'],
        ],
      ],
    ]);
    const parsed = [readTextGrid(grid, 'a.TextGrid')];
    const { nodes } = compareSchemas(parsed);
    const roles = suggestRoles(nodes);
    const words = nodes.find((n) => n.baseName === 'words');
    roles[words.key] = ROLES.WORD;
    expect(validateRoles(nodes, roles)).toEqual([]);
    const [doc] = buildElanDocuments(parsed, nodes, roles).documents;
    expect(doc.words.map((w) => doc.body.slice(w.begin, w.end))).toEqual(['los', 'perros']);
    expect(doc.alignments.map((a) => [a.timeBegin, a.timeEnd])).toEqual([[0.5, 2.5]]);
  });

  it('reads the short format the same as the long one', () => {
    const short = [
      'File type = "ooTextFile"',
      'Object class = "TextGrid"',
      '',
      '0',
      '5',
      '<exists>',
      '2',
      '"IntervalTier"',
      '"transcription"',
      '0',
      '5',
      '5',
      '0',
      '0.5',
      '""',
      '0.5',
      '2',
      '"los perros corren"',
      '2',
      '2.5',
      '""',
      '2.5',
      '4',
      '"el gato ""duerme"""',
      '4',
      '5',
      '""',
      '"IntervalTier"',
      '"translation"',
      '0',
      '5',
      '5',
      '0',
      '0.5',
      '""',
      '0.5',
      '2',
      '"the dogs run"',
      '2',
      '2.5',
      '""',
      '2.5',
      '4',
      '"the cat sleeps"',
      '4',
      '5',
      '""',
    ].join('\n');
    const strip = (tg) =>
      tg.tiers.map((t) => [t.id, t.parentRef, t.annotations.map((a) => a.value)]);
    expect(strip(readTextGrid(short, 's.TextGrid'))).toEqual(
      strip(readTextGrid(FIELD, 'l.TextGrid')),
    );
  });

  it('takes a point tier as a tier with nothing on it', () => {
    const grid = FIELD.replace('size = 2 \nitem []: ', 'size = 3 \nitem []: ').concat(
      '\n    item [3]:\n        class = "TextTier" \n        name = "events" \n        xmin = 0 \n' +
        '        xmax = 5 \n        points: size = 1 \n        points [1]:\n' +
        '            number = 1.5 \n            mark = "cough" \n',
    );
    const tg = readTextGrid(grid, 'p.TextGrid');
    expect(tg.tiers.map((t) => [t.id, t.annotations.length])).toEqual([
      ['transcription', 2],
      ['translation', 2],
      ['events', 0],
    ]);
  });

  it('reads the speaker from a tier name, and matches tiers within one speaker', () => {
    const tg = readTextGrid(
      longGrid(3, [
        ['Sentence@Ana', [[0, 1, 'hola']]],
        ['Sentence@Bo', [[0, 1, 'hi']]],
        ['Translation@Bo', [[0, 1, 'hello']]],
      ]),
      'two.TextGrid',
    );
    expect(tg.tiers.map((t) => [t.participant, t.baseName, t.parentRef])).toEqual([
      ['Ana', 'Sentence', null],
      ['Bo', 'Sentence', null],
      ['Bo', 'Translation', 'Sentence@Bo'],
    ]);
  });

  it('reads back its own export as sentences, their times and their translation', () => {
    const doc = makeFixtureDoc({ alignmentTokens: [makeAlignmentToken('a1', 0, 14, 1.25, 3.5)] });
    const text = buildTextGrid(doc, { sentFields: ['Translation'], morphFields: ['Gloss'] });
    const { nodes, roles, build: built } = build([[text, 'Test.TextGrid']]);
    const roleOf = (name) => roles[nodes.find((n) => n.baseName === name).key];
    expect(roleOf('Sentence')).toBe(ROLES.UTTERANCE);
    expect(roleOf('Translation')).toBe(ROLES.SENTENCE_FIELD);
    const [d] = built.documents;
    expect(d.body).toBe('perros corren.');
    expect(d.sentences[0].fields.Translation).toBe('The dogs run.');
    expect(d.alignments.map((a) => [a.timeBegin, a.timeEnd])).toEqual([[1.25, 3.5]]);
  });

  it('gives two tiers of one name, and a tier with none, names of their own', () => {
    const grid = readTextGrid(
      longGrid(2, [
        ['words@Ana', [[0, 1, 'a']]],
        ['words@Ana', [[0, 1, 'b']]],
        ['', [[1, 2, 'x']]],
      ]),
      't.TextGrid',
    );
    expect(grid.tiers.map((t) => [t.id, t.participant, t.parentRef])).toEqual([
      ['words@Ana', 'Ana', null],
      ['words (2)@Ana', 'Ana', 'words@Ana'],
      ['Tier 3', '', null],
    ]);
    expect(compareSchemas([grid]).nodes.map((n) => n.tierIds)).toEqual([
      ['words@Ana'],
      ['words (2)@Ana'],
      ['Tier 3'],
    ]);
  });

  it('refuses a binary TextGrid and a file that is not one', async () => {
    // Praat's binary format: the bytes "ooBinaryFile", a length, the class.
    const bytes = new Uint8Array([...'ooBinaryFile\bTextGrid'].map((c) => c.charCodeAt(0)));
    const binary = new File([bytes, new Uint8Array([0, 0, 0xff, 0x40])], 'b.TextGrid');
    await expect(readTextGridFile(binary)).rejects.toThrow(
      'b.TextGrid is a binary TextGrid. Save it from Praat as a text file.',
    );
    expect(() => readTextGrid('ooBinaryFile\bTextGrid', 'b.TextGrid')).toThrow(EafError);
    // A text file Praat saved as UTF-16 is read as what it is.
    const text = longGrid(1, [['tx', [[0, 1, 'né']]]]);
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xfe, 0xff]);
    [...text].forEach((c, i) => {
      utf16[2 + i * 2] = c.charCodeAt(0) >> 8;
      utf16[3 + i * 2] = c.charCodeAt(0) & 0xff;
    });
    const read = await readTextGridFile(new File([utf16], 'u.TextGrid'));
    expect(read.tiers[0].annotations[0].value).toBe('né');
    expect(() =>
      readTextGrid('File type = "ooTextFile"\nObject class = "Sound"\n', 's.TextGrid'),
    ).toThrow('s.TextGrid is not a Praat TextGrid.');
    expect(() => readTextGrid('hello', 'h.TextGrid')).toThrow(/is missing/);
  });
});
