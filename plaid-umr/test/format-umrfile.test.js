import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile, serializeUmrFile, modernHeader } from '../src/domain/format/umrFile.js';

const SEPARATOR = '#'.repeat(80);

const MINIMAL = `${SEPARATOR}
# meta-info :: sent_id = x-1
# :: snt1
Index: 1 2
Words: the boy

# sentence level graph:
(s1b / boy)

# alignment:
s1b: 2-2

# document level annotation:
(s1s0 / sentence
    :temporal ((document-creation-time :before s1b)))

`;

const codes = (list) => list.map((entry) => entry.code);
const first = (text) => parseUmrFile(text).sentences[0];

describe('parseUmrFile', () => {
  test('reads the four blocks', () => {
    const { sentences, errors, warnings } = parseUmrFile(MINIMAL);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.equal(sentences.length, 1);
    const sentence = sentences[0];
    assert.equal(sentence.index, 1);
    assert.equal(sentence.snt, 1);
    assert.equal(sentence.sentenceText, '');
    assert.deepEqual(sentence.meta, ['# meta-info :: sent_id = x-1']);
    assert.deepEqual(sentence.words, ['the', 'boy']);
    assert.equal(sentence.graph.root, 's1b');
    assert.deepEqual(sentence.alignment.get('s1b'), [[2, 2]]);
    assert.deepEqual(sentence.docGraph, {
      var: 's1s0',
      temporal: [['document-creation-time', ':before', 's1b']],
      modal: [],
      coref: [],
    });
  });

  test('keeps the four block texts verbatim', () => {
    const sentence = first(MINIMAL);
    assert.equal(sentence.raw.graph, '(s1b / boy)');
    assert.equal(sentence.raw.alignment, 's1b: 2-2');
    assert.match(sentence.raw.tokens, /^# meta-info/);
  });

  test('an empty block is not an error', () => {
    const text = `${SEPARATOR}
# :: snt1
Index: 1
Words: boy

# sentence level graph:

# alignment:

# document level annotation:

`;
    const sentence = first(text);
    assert.equal(sentence.graph, null);
    assert.equal(sentence.docGraph, null);
    assert.equal(sentence.alignment.size, 0);
  });

  describe('tolerances', () => {
    test('two empty lines between blocks, as the English corpus writes them', () => {
      const sentence = first(MINIMAL.replace(/\n\n/g, '\n\n\n'));
      assert.equal(sentence.graph.root, 's1b');
      assert.deepEqual(sentence.words, ['the', 'boy']);
    });

    test('no sentence id line at all, as Arapaho, Kukama and Navajo write them', () => {
      const { sentences, warnings } = parseUmrFile(MINIMAL.replace('# :: snt1\n', ''));
      assert.equal(sentences[0].snt, 1);
      assert.deepEqual(codes(warnings), ['missing-sent-id']);
    });

    test('a space before the alignment colon, as Navajo writes it', () => {
      const { sentences, warnings } = parseUmrFile(MINIMAL.replace('s1b: 2-2', 's1b :2-2'));
      assert.deepEqual(sentences[0].alignment.get('s1b'), [[2, 2]]);
      assert.deepEqual(codes(warnings), ['alignment-space-before-colon']);
    });

    test("UMR 1.0's -1--1 means unaligned, as 0-0 does", () => {
      const { sentences, warnings } = parseUmrFile(MINIMAL.replace('s1b: 2-2', 's1b: -1--1'));
      assert.deepEqual(sentences[0].alignment.get('s1b'), []);
      assert.deepEqual(codes(warnings), ['legacy-unaligned']);
    });

    test('a trailing separator with nothing after it is not a sentence', () => {
      const { sentences } = parseUmrFile(`${MINIMAL}\n${SEPARATOR}\n`);
      assert.equal(sentences.length, 1);
    });

    test('a triple carrying a concept, as Kukama writes it', () => {
      const text = MINIMAL.replace(
        '((document-creation-time :before s1b))',
        '((past-reference / past-reference :contained s1b))',
      );
      const sentence = first(text);
      assert.deepEqual(sentence.docGraph.temporal, [['past-reference', ':contained', 's1b']]);
    });

    test('a discontiguous alignment', () => {
      const sentence = first(MINIMAL.replace('s1b: 2-2', 's1b: 2-2, 4-5'));
      assert.deepEqual(sentence.alignment.get('s1b'), [
        [2, 2],
        [4, 5],
      ]);
    });
  });

  describe('interlinear headers', () => {
    const header = (line) => first(MINIMAL.replace('Index: 1 2', `${line}\nIndex: 1 2`)).ilg[0];

    test('the modern ones carry a key and a language', () => {
      assert.deepEqual(header('Word Gloss (en): the boy'), {
        header: 'Word Gloss (en)',
        key: 'word-gloss',
        lang: 'en',
        items: ['the', 'boy'],
      });
      assert.equal(header('Part of Speech: DET NOUN').key, 'pos');
      assert.equal(header('Morpheme Category: v:Any').key, 'morpheme-category');
    });

    test('the obsolete ones map to the same keys', () => {
      assert.deepEqual(
        [
          header('Morpheme Gloss(en): a b'),
          header('Morpheme Cat: a b'),
          header('Morphemes(English): a b'),
          header('Translation(English): a b'),
          header('English Sent Gloss: a b'),
          header('Spanish Sent Gloss: a b'),
          header('Word Gloss: a b'),
          header('tx: a b'),
          header('mb: a b'),
          header('ge: a b'),
          header('ps: a b'),
          header('tr: a b'),
        ].map((line) => [line.key, line.lang]),
        [
          ['morpheme-gloss', 'en'],
          ['morpheme-category', null],
          ['morpheme-gloss', 'en'],
          ['sentence-gloss', 'en'],
          ['sentence-gloss', 'en'],
          ['sentence-gloss', 'es'],
          ['word-gloss', null],
          ['words', null],
          ['morphemes', null],
          ['morpheme-gloss', null],
          ['pos', null],
          ['sentence-gloss', null],
        ],
      );
    });

    test('an obsolete header is a warning', () => {
      const { warnings } = parseUmrFile(
        MINIMAL.replace('Index: 1 2', 'Morpheme Cat: a b\nIndex: 1 2'),
      );
      assert.deepEqual(codes(warnings), ['obsolete-ilg']);
    });

    test('an unrecognized header is kept under the key "other"', () => {
      const line = header('Speaker: Ann');
      assert.equal(line.key, 'other');
      assert.equal(line.header, 'Speaker');
    });
  });
});

describe('modernHeader', () => {
  test('upgrades an obsolete header', () => {
    assert.equal(modernHeader({ key: 'morpheme-category', lang: null }), 'Morpheme Category');
    assert.equal(modernHeader({ key: 'sentence-gloss', lang: 'es' }), 'Sentence Gloss (es)');
  });

  test("a gloss with no language of its own is written as 'und'", () => {
    assert.equal(modernHeader({ key: 'word-gloss', lang: null }), 'Word Gloss (und)');
  });

  test('a header nobody knows is written back as it came', () => {
    assert.equal(modernHeader({ key: 'other', header: 'Speaker', lang: null }), 'Speaker');
  });
});

describe('serializeUmrFile', () => {
  test('writes the blocks in order with their headers', () => {
    const out = serializeUmrFile(parseUmrFile(MINIMAL));
    assert.equal(
      out,
      `${SEPARATOR}
# meta-info :: sent_id = x-1
# :: snt1
Index: 1 2
Words: the boy

# sentence level graph:
(s1b / boy)

# alignment:
s1b: 2-2

# document level annotation:
(s1s0 / sentence
    :temporal ((document-creation-time :before s1b)))


`,
    );
  });

  test('every node of the graph gets an alignment line, 0-0 when it has none', () => {
    const out = serializeUmrFile(
      parseUmrFile(MINIMAL.replace('(s1b / boy)', '(s1b / boy\n    :mod (s1t / tall))')),
    );
    assert.match(out, /# alignment:\ns1b: 2-2\ns1t: 0-0\n/);
  });

  test('a sentence with no graph still writes all four blocks', () => {
    const empty = {
      index: 1,
      snt: 1,
      sentenceText: '',
      meta: [],
      ilg: [],
      words: ['boy'],
      graph: null,
      alignment: new Map(),
      docGraph: null,
    };
    const out = serializeUmrFile({ sentences: [empty] });
    assert.match(out, /# sentence level graph:\n\n# alignment:\n\n# document level annotation:\n/);
    assert.match(out, /Index: 1\nWords: boy\n/);
  });

  test('the text is stable: writing what was written changes nothing', () => {
    const once = serializeUmrFile(parseUmrFile(MINIMAL));
    assert.equal(serializeUmrFile(parseUmrFile(once)), once);
  });
});

// umr-export-sentence-text: validate.py rejects tokens on the sentence id
// line once a Words line follows, so the id line is bare and the text has a
// Sentence line of its own, only where it is not the Words joined by spaces.
describe('the sentence text', () => {
  const withText = (sentenceText, over = {}) => ({
    ...first(MINIMAL),
    sentenceText,
    words: ['the', 'boy', '.'],
    ilg: [],
    ...over,
  });
  const lines = (sentence) => serializeUmrFile({ sentences: [sentence] }).split('\n');

  test('the sentence id line is bare', () => {
    assert.ok(lines(withText('The boy.')).includes('# :: snt1'));
  });

  test('a text that is not the words joined by spaces has a Sentence line', () => {
    const out = lines(withText('The boy.'));
    assert.deepEqual(out.slice(3, 6), [
      'Index:    1 2 3',
      'Words:    the boy .',
      'Sentence: The boy.',
    ]);
    assert.equal(first(out.join('\n')).sentenceText, 'The boy.');
  });

  test('a text that is the words joined by spaces has none', () => {
    assert.ok(!lines(withText('the boy .')).some((line) => line.startsWith('Sentence')));
    assert.ok(!lines(withText('')).some((line) => line.startsWith('Sentence')));
  });

  test('the Sentence line goes before the translations', () => {
    const out = lines(
      withText('The boy.', {
        ilg: [
          {
            key: 'sentence-gloss',
            lang: 'es',
            header: 'Sentence Gloss (es)',
            items: ['El', 'niño.'],
          },
        ],
      }),
    );
    const at = (prefix) => out.findIndex((line) => line.startsWith(prefix));
    assert.ok(at('Sentence:') !== -1 && at('Sentence:') < at('Sentence Gloss'));
  });

  test('a sentence that already has a Sentence line gets no second one', () => {
    const out = lines(
      withText('The boy.', {
        ilg: [{ key: 'sentence', lang: null, header: 'Sentence', items: ['The', 'boy!'] }],
      }),
    );
    assert.deepEqual(
      out.filter((line) => line.startsWith('Sentence')),
      ['Sentence: The boy!'],
    );
  });

  // validate.py fails a Sentence line with more items than Words
  // (sentence-word-mismatch), which only a word holding a space can make.
  test('a text with more items than the Words line has none', () => {
    const s = withText('in order to go', { words: ['in_order', 'to', 'go'] });
    assert.ok(!lines(s).some((line) => line.startsWith('Sentence')));
  });

  test('read: a Sentence line is the text, and wins over text after the id', () => {
    const text = MINIMAL.replace('# :: snt1', '# :: snt1\tthe boy').replace(
      'Words: the boy',
      'Words: the boy\nSentence: The  boy!',
    );
    assert.equal(first(text).sentenceText, 'The  boy!');
    assert.equal(first(MINIMAL.replace('# :: snt1', '# :: snt1\tthe boy')).sentenceText, 'the boy');
  });
});

// umr-export-nfc: the format requires the whole file in NFC, and IGT may
// store a word with a combining accent.
test('the export is written in Unicode NFC', () => {
  const e = 'e\u0301';
  const out = serializeUmrFile({
    sentences: [
      {
        ...first(MINIMAL),
        words: ['the', `caf${e}`],
        ilg: [],
        sentenceText: `The caf${e}.`,
        meta: [`# note caf${e}`],
      },
    ],
  });
  assert.equal(out, out.normalize('NFC'));
  assert.match(out, /Words: {4}the caf\u00e9\n/);
  assert.match(out, /Sentence: The caf\u00e9\.\n/);
});
