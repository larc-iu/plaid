import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import {
  validateSentence,
  validateDocument,
  valueGrammarProblem,
} from '../src/domain/format/validate.js';

const SEPARATOR = '#'.repeat(80);

// One sentence, written the way a .umr file writes it, so that the checks see
// exactly the shape the parser produces.
function sentence({ words = 'the boy went .', graph = '', alignment = '', doc = '' }) {
  const items = words.split(' ');
  const text = [
    SEPARATOR,
    '# :: snt1',
    `Index: ${items.map((_, i) => i + 1).join(' ')}`,
    `Words: ${words}`,
    '',
    '# sentence level graph:',
    graph,
    '',
    '# alignment:',
    alignment,
    '',
    '# document level annotation:',
    doc,
    '',
    '',
  ].join('\n');
  return parseUmrFile(text).sentences[0];
}

const codes = (findings) => findings.map((finding) => finding.code);

// Alignment and document-level completeness are checked in their own tests;
// switching them off elsewhere keeps each test to the one thing it is about.
const quiet = {
  checkCompleteAlignment: false,
  checkUnalignedToken: false,
  requireDocumentLevel: false,
};

describe('sentence graph', () => {
  test('an event without :aspect', () => {
    const found = validateSentence(
      sentence({ graph: '(s1g / go-01\n    :ARG0 (s1b / boy))' }),
      quiet,
    );
    assert.deepEqual(codes(found), ['missing-attribute']);
    assert.match(found[0].message, /s1g/);
  });

  test('an event with :aspect is fine', () => {
    const found = validateSentence(
      sentence({ graph: '(s1g / go-01\n    :aspect performance\n    :ARG0 (s1b / boy))' }),
      quiet,
    );
    assert.deepEqual(codes(found), []);
  });

  test('a relation nobody knows', () => {
    const found = validateSentence(
      sentence({ graph: '(s1b / boy\n    :nonsense (s1c / cat))' }),
      quiet,
    );
    assert.deepEqual(codes(found), ['unknown-relation']);
  });

  test('a value outside the attribute set', () => {
    const found = validateSentence(sentence({ graph: '(s1g / go-01\n    :aspect bogus)' }), quiet);
    assert.deepEqual(codes(found), ['unexpected-value']);
    assert.match(found[0].message, /'bogus'/);
  });

  test('the two inventories disagree about iterative', () => {
    const subject = sentence({ graph: '(s1g / go-01\n    :aspect iterative)' });
    assert.deepEqual(codes(validateSentence(subject, quiet)), ['unexpected-value']);
    assert.deepEqual(codes(validateSentence(subject, { ...quiet, sets: 'schema' })), []);
  });

  test('a child node where an attribute belongs', () => {
    const found = validateSentence(
      sentence({ graph: '(s1g / go-01\n    :aspect (s1s / state))' }),
      quiet,
    );
    assert.deepEqual(codes(found), ['unexpected-value']);
  });

  test('an atom where a child node belongs', () => {
    const found = validateSentence(
      sentence({ graph: '(s1g / go-01\n    :aspect state\n    :ARG0 boy)' }),
      quiet,
    );
    assert.deepEqual(codes(found), ['unexpected-value']);
  });

  test('a relation that may not repeat', () => {
    const found = validateSentence(
      sentence({
        graph: '(s1g / go-01\n    :aspect state\n    :ARG0 (s1b / boy)\n    :ARG0 (s1c / cat))',
      }),
      quiet,
    );
    assert.deepEqual(codes(found), ['repeated-relation']);
  });

  test('a gap in the :op numbering', () => {
    const found = validateSentence(
      sentence({ graph: '(s1a / and\n    :op1 (s1b / boy)\n    :op3 (s1c / cat))' }),
      quiet,
    );
    assert.deepEqual(codes(found), ['skipped-op-relation']);
  });

  test('a cycle, reported where it closes', () => {
    const found = validateSentence(
      sentence({
        graph: '(s1g / go-01\n    :aspect state\n    :ARG0 (s1b / boy\n        :mod s1g))',
      }),
      quiet,
    );
    assert.deepEqual(codes(found), ['cycle']);
  });

  test('a cycle through :quote is allowed', () => {
    const found = validateSentence(
      sentence({
        graph: '(s1s / say-01\n    :aspect state\n    :ARG0 (s1b / boy\n        :quote s1s))',
      }),
      quiet,
    );
    assert.deepEqual(codes(found), []);
  });

  test('a reference to a node written out later', () => {
    const found = validateSentence(
      sentence({
        graph: '(s1g / go-01\n    :aspect state\n    :mod s1b\n    :ARG0 (s1b / boy))',
      }),
      quiet,
    );
    assert.deepEqual(codes(found), ['forward-reference']);
    assert.equal(found[0].level, 'warning');
  });

  test('a name concept wants an incoming :name and an outgoing :op1', () => {
    const found = validateSentence(
      sentence({ graph: '(s1n / name\n    :mod (s1b / boy))' }),
      quiet,
    );
    assert.deepEqual(codes(found).sort(), [
      'missing-incoming-name',
      'missing-outgoing-name',
      'wrong-outgoing-name',
    ]);
  });

  test(':wiki must be a Wikidata id', () => {
    const found = validateSentence(
      sentence({ graph: '(s1c / country\n    :wiki "Philippines")' }),
      quiet,
    );
    assert.deepEqual(codes(found), ['unexpected-value']);
    assert.match(found[0].message, /Wikidata/);
  });
});

describe('alignment', () => {
  test('a span past the end of the sentence', () => {
    const found = validateSentence(
      sentence({ words: 'the boy', graph: '(s1b / boy)', alignment: 's1b: 5-5' }),
      { ...quiet, checkCompleteAlignment: true },
    );
    assert.deepEqual(codes(found), ['invalid-token-index']);
  });

  test('a span that runs backwards', () => {
    const found = validateSentence(
      sentence({ words: 'the boy', graph: '(s1b / boy)', alignment: 's1b: 2-1' }),
      quiet,
    );
    assert.deepEqual(codes(found), ['invalid-token-range']);
  });

  test('a node with no alignment line at all', () => {
    const found = validateSentence(sentence({ words: 'the boy', graph: '(s1b / boy)' }), {
      ...quiet,
      checkCompleteAlignment: true,
    });
    assert.deepEqual(codes(found), ['missing-alignment']);
  });

  test('an alignment for a node that is not in the graph', () => {
    const found = validateSentence(
      sentence({ words: 'the boy', graph: '(s1b / boy)', alignment: 's1b: 2-2\ns1z: 1-1' }),
      quiet,
    );
    assert.deepEqual(codes(found), ['unknown-node-id']);
  });

  test('a word no node covers', () => {
    const found = validateSentence(
      sentence({ words: 'the boy .', graph: '(s1b / boy)', alignment: 's1b: 2-2' }),
      { ...quiet, checkUnalignedToken: true },
    );
    // The full stop is punctuation, so only 'the' is reported.
    assert.deepEqual(codes(found), ['unaligned-token']);
    assert.match(found[0].message, /'the'/);
  });
});

describe('document graph', () => {
  test('a relation to a variable nothing defines', () => {
    const found = validateSentence(
      sentence({
        graph: '(s1g / go-01\n    :aspect state)',
        alignment: 's1g: 0-0',
        doc: '(s1s0 / sentence\n    :temporal ((s1g :before s9z)))',
      }),
      quiet,
    );
    assert.deepEqual(codes(found), ['unknown-node-id']);
    assert.match(found[0].message, /s9z/);
  });

  test('a constant is not an unknown variable', () => {
    const found = validateSentence(
      sentence({
        graph: '(s1g / go-01\n    :aspect state)',
        alignment: 's1g: 0-0',
        doc: '(s1s0 / sentence\n    :temporal ((document-creation-time :before s1g)))',
      }),
      quiet,
    );
    assert.deepEqual(codes(found), []);
  });

  test('a relation nobody knows in the group', () => {
    const found = validateSentence(
      sentence({
        graph: '(s1g / go-01\n    :aspect state)',
        alignment: 's1g: 0-0',
        doc: '(s1s0 / sentence\n    :temporal ((document-creation-time :sideways s1g)))',
      }),
      quiet,
    );
    assert.deepEqual(codes(found), ['unknown-document-relation']);
  });

  test('an event with no temporal relation', () => {
    const found = validateSentence(
      sentence({ graph: '(s1g / go-01\n    :aspect state)', alignment: 's1g: 0-0' }),
      { checkCompleteAlignment: false, checkUnalignedToken: false },
    );
    assert.deepEqual(codes(found), ['missing-temporal']);
  });
});

describe('validateDocument', () => {
  const twoSentences = `${SEPARATOR}
# :: snt1
Index: 1
Words: boy

# sentence level graph:
(s1b / boy)

# alignment:
s1b: 1-1

# document level annotation:


${SEPARATOR}
# :: snt2
Index: 1
Words: boy

# sentence level graph:
(s2g / go-01
    :aspect state
    :ARG0 s1b)

# alignment:
s2g: 1-1

# document level annotation:
(s2s0 / sentence
    :coref ((s1b :same-entity s2g)))

`;

  test('a sentence graph may not reach into another sentence', () => {
    const { sentences } = parseUmrFile(twoSentences);
    const found = validateDocument(sentences, quiet);
    const crossing = found.filter((finding) => finding.code === 'cross-sentence-reference');
    assert.equal(crossing.length, 1);
    assert.equal(crossing[0].sentence, 2);
  });

  test('a document-level relation may reach back', () => {
    const { sentences } = parseUmrFile(twoSentences);
    const found = validateDocument(sentences, quiet);
    assert.equal(
      found.filter((finding) => finding.code === 'unknown-node-id').length,
      0,
      's1b is known to sentence 2 in the document graph',
    );
  });

  test('every finding says which sentence it came from', () => {
    const { sentences } = parseUmrFile(twoSentences);
    validateDocument(sentences, quiet).forEach((finding) => {
      assert.ok(finding.sentence >= 1);
    });
  });
});

// The value grammar validate.py reads a sentence graph with
// (validate.py:392-398). The app's own reader is looser, so a value it takes
// can still break the whole sentence for the official validator.
describe('values validate.py cannot read', () => {
  const valueCodes = (graph) =>
    codes(validateSentence(sentence({ graph }), quiet)).filter(
      (code) => code !== 'unexpected-value',
    );

  test('an atom with a capital or an underscore', () => {
    assert.deepEqual(valueCodes('(s1b / boy\n    :mode Imperative)'), ['value-wrong-chars']);
    assert.deepEqual(valueCodes('(s1b / boy\n    :mod big_one)'), ['value-wrong-chars']);
  });

  test('an atom it does not read at all', () => {
    assert.deepEqual(valueCodes('(s1b / boy\n    :quant .5)'), ['missing-node-definition']);
    assert.deepEqual(valueCodes('(s1b / boy\n    :mod caf\u00e9)'), ['missing-node-definition']);
    assert.deepEqual(valueCodes('(s1b / boy\n    :mod a/b)'), ['missing-node-definition']);
  });

  test('a string that is empty, holds a quote or runs over a line', () => {
    assert.deepEqual(valueCodes('(s1b / boy\n    :mod "")'), ['missing-node-definition']);
    assert.deepEqual(valueCodes('(s1b / boy\n    :mod "O\\"Brien")'), ['invalid-sentence-level']);
    assert.deepEqual(valueCodes('(s1b / boy\n    :mod "a\nb")'), ['invalid-line']);
  });

  test('what it does read', () => {
    [
      ':quant 3.5',
      ':quant 12',
      ':time 15:30',
      ':polarity -',
      ':mod +',
      ':mod "Caf\u00e9 Noir"',
    ].forEach((child) => assert.deepEqual(valueCodes(`(s1b / boy\n    ${child})`), [], child));
  });

  test('a bare value that starts like a variable is read as a reference', () => {
    assert.deepEqual(valueCodes('(s1b / boy\n    :mod s1x-b)'), ['invalid-sentence-level']);
  });

  // The check the editors refuse new input with (umr-export-value-grammar),
  // on the value as it is stored.
  test('valueGrammarProblem judges a stored value alone', () => {
    const code = (value) => valueGrammarProblem(value)?.code ?? null;
    assert.equal(code('imperative'), null);
    assert.equal(code('15:30'), null);
    assert.equal(code('3.5'), null);
    assert.equal(code('-'), null);
    assert.equal(code('"Caf\u00e9 Noir"'), null);
    assert.equal(code('Imperative'), 'value-wrong-chars');
    assert.equal(code('caf\u00e9'), 'missing-node-definition');
    assert.equal(code('.5'), 'missing-node-definition');
    assert.equal(code(''), 'missing-node-definition');
    assert.equal(code('""'), 'missing-node-definition');
    assert.equal(code('"O\\"Brien"'), 'invalid-sentence-level');
    assert.equal(code('"a\nb"'), 'invalid-line');
    assert.equal(code('s2x'), 'invalid-sentence-level');
    assert.equal(
      valueGrammarProblem('Imperative', ':mode').message,
      "The value 'Imperative' of ':mode' holds a capital letter or an underscore.",
    );
    assert.equal(
      valueGrammarProblem('caf\u00e9').message,
      "The value 'caf\u00e9' is not a number or a word of lowercase letters, digits, + and -.",
    );
  });

  test('the message says what is wrong in the value', () => {
    const [found] = validateSentence(
      sentence({ graph: '(s1b / boy\n    :mode Imperative)' }),
      quiet,
    );
    assert.equal(
      found.message,
      "The value 'Imperative' of ':mode' holds a capital letter or an underscore.",
    );
    assert.equal(found.var, 's1b');
  });
});

describe('text in NFC', () => {
  // As the app hands a sentence to the checks, not as a file reads: the
  // reader normalizes, the model may hold what the API stored.
  const inApp = ({ variable = 's1c', concept = 'cat', value = '"x"', words = ['cat'] }) => ({
    index: 1,
    words,
    graph: {
      root: variable,
      nodes: new Map([
        [variable, { var: variable, concept, children: [{ rel: ':mod', kind: 'string', value }] }],
      ]),
      errors: [],
    },
    alignment: new Map([[variable, [[1, 1]]]]),
    docGraph: null,
  });
  const nfcFindings = (s) =>
    validateSentence(s, quiet).filter((finding) => finding.code === 'unicode-normalization');

  test('a concept, a variable and a value are each named', () => {
    const e = 'e\u0301';
    assert.deepEqual(
      nfcFindings(inApp({ concept: `caf${e}` })).map((f) => f.message),
      [`The concept 'caf${e}' of 's1c' is not in Unicode NFC.`],
    );
    assert.equal(nfcFindings(inApp({ variable: `s1${e}` })).length, 1);
    assert.equal(nfcFindings(inApp({ value: `"caf${e}"` })).length, 1);
  });

  // The export writes the file in NFC (umr-export-nfc), so the text IGT
  // stores is not a finding: a word, a gloss line, the sentence text and a
  // metadata line.
  test('words and the lines around the graph are not reported', () => {
    const e = 'e\u0301';
    const s = {
      ...inApp({ words: ['le', `caf${e}`] }),
      ilg: [
        { key: 'words', header: 'Words', items: ['le', `caf${e}`] },
        { key: 'morpheme-gloss', header: 'Morpheme Gloss (en)', items: ['cat', `caf${e}`] },
      ],
      sentenceText: `le caf${e}`,
      meta: [`# note: caf${e}`],
    };
    assert.deepEqual(nfcFindings(s), []);
  });

  test('composed text is not reported', () => {
    assert.deepEqual(nfcFindings(inApp({ concept: 'caf\u00e9', words: ['caf\u00e9'] })), []);
  });
});

describe('messages', () => {
  test('an atom is "an atom"', () => {
    const found = validateSentence(
      sentence({ graph: '(s1p / person\n    :name (s1n / name\n        :op1 bob))' }),
      quiet,
    );
    const message = found.find((f) => f.code === 'unexpected-value').message;
    assert.match(message, /found an atom\.$/);
  });
});

describe('coreference across the document', () => {
  const at = (index, spec) => ({ ...sentence(spec), index });

  test('an event in a :same-entity relation', () => {
    const found = validateDocument(
      [
        at(1, { graph: '(s1g / go-01\n    :aspect performance)' }),
        at(2, {
          graph: '(s2b / boy)',
          doc: '(s2s0 / sentence\n    :coref ((s1g :same-entity s2b)))',
        }),
      ],
      quiet,
    ).filter((f) => f.code === 'coref-entity-event-mismatch');
    assert.deepEqual(
      found.map((f) => [f.sentence, f.var, f.message]),
      [
        [
          2,
          's1g',
          "'s1g' cannot be in a :same-entity relation. It is an event because it has the outgoing relation :aspect.",
        ],
      ],
    );
  });

  test('a node an earlier relation made an entity, in a :same-event relation', () => {
    const found = validateDocument(
      [
        at(1, {
          graph: '(s1b / boy)',
          doc: '(s1s0 / sentence\n    :coref ((s1b :same-entity s1b)))',
        }),
        at(2, {
          graph: '(s2t / thing)',
          doc: '(s2s0 / sentence\n    :coref ((s1b :same-event s2t)))',
        }),
      ],
      quiet,
    ).filter((f) => f.code === 'coref-entity-event-mismatch');
    assert.deepEqual(
      found.map((f) => [f.sentence, f.var]),
      [[2, 's1b']],
    );
    assert.match(found[0].message, /entity because it is in a :same-entity relation/);
  });

  test('two entities and two events are fine', () => {
    const found = validateDocument(
      [
        at(1, { graph: '(s1g / go-01\n    :aspect performance\n    :ARG0 (s1b / boy))' }),
        at(2, {
          graph: '(s2g / go-01\n    :aspect performance\n    :ARG0 (s2h / he))',
          doc: '(s2s0 / sentence\n    :coref ((s1b :same-entity s2h)\n        (s1g :same-event s2g)))',
        }),
      ],
      quiet,
    );
    assert.deepEqual(
      found.filter((f) => f.code === 'coref-entity-event-mismatch'),
      [],
    );
  });

  test('a cluster with two Wikidata ids', () => {
    const person = (v, wiki) => `(${v} / person\n    :wiki "${wiki}")`;
    const sentences = [
      at(1, { graph: person('s1p', 'Q1') }),
      at(2, {
        graph: person('s2p', 'Q2'),
        doc: '(s2s0 / sentence\n    :coref ((s1p :same-entity s2p)))',
      }),
      at(3, {
        graph: person('s3p', 'Q1'),
        doc: '(s3s0 / sentence\n    :coref ((s3p :same-entity s2p)))',
      }),
    ];
    const found = validateDocument(sentences, quiet).filter(
      (f) => f.code === 'coref-wiki-mismatch',
    );
    assert.deepEqual(
      found.map((f) => [f.sentence, f.var, f.message]),
      [
        [
          2,
          's2p',
          "'s2p' has the Wikidata id Q2, and it corefers with 's1p', whose Wikidata id is Q1.",
        ],
      ],
    );
    // As validate.py's --no-check-wiki.
    assert.deepEqual(
      validateDocument(sentences, { ...quiet, checkWiki: false }).filter(
        (f) => f.code === 'coref-wiki-mismatch',
      ),
      [],
    );
  });
});

// validate.py's temporal graph (build_temporal_graph): every stated relation,
// its opposite, what follows from them by :before, :after and :contained, and
// coreferent nodes as one. A relation that collides with one already known is
// a `temporal-mismatch`. The expected lists are what validate.py reports on
// the same documents, in its order, as [sentence, node, old relation, new
// relation, node].
describe('temporal contradictions', () => {
  const SEP = '#'.repeat(80);
  // Sentence n holds (sNa / and :op1 sNx :op2 sNy), two events.
  const doc = (specs) => {
    const text = specs
      .map(({ temporal = [], coref = [] }, i) => {
        const n = i + 1;
        const groups = [
          ['temporal', temporal],
          ['coref', coref],
        ]
          .filter(([, triples]) => triples.length)
          .map(([g, triples]) => `    :${g} (${triples.map((t) => `(${t})`).join('\n        ')})`);
        return [
          SEP,
          `# :: snt${n}`,
          'Index: 1 2 3',
          'Words: and go come',
          '',
          '# sentence level graph:',
          `(s${n}a / and\n    :op1 (s${n}x / go-01\n        :aspect performance)\n    :op2 (s${n}y / come-01\n        :aspect performance))`,
          '',
          '# alignment:',
          `s${n}a: 1-1\ns${n}x: 2-2\ns${n}y: 3-3`,
          '',
          '# document level annotation:',
          `(s${n}s0 / sentence${groups.length ? `\n${groups.join('\n')}` : ''})`,
          '',
          '',
          '',
        ].join('\n');
      })
      .join('');
    return parseUmrFile(text).sentences;
  };
  const RELATION = /both '(\S+) (.+?) (\S+)' \(from .*?\) and '\S+ (.+?) \S+' \(from/;
  const mismatches = (sentences) =>
    validateDocument(sentences)
      .filter((f) => f.code === 'temporal-mismatch')
      .map((f) => {
        const [, a, older, b, newer] = RELATION.exec(f.message);
        return [f.sentence, a, older, newer, b];
      });

  test('a relation and its opposite, stated together', () => {
    assert.deepEqual(
      mismatches(
        doc([
          {
            temporal: [
              'document-creation-time :before s1x',
              'document-creation-time :before s1y',
              's1x :before s1y',
              's1x :after s1y',
            ],
          },
        ]),
      ),
      [
        [1, 's1x', ':before', ':after', 's1y'],
        [1, 's1y', ':after', ':before', 's1x'],
      ],
    );
  });

  test('the message names both relations and where each comes from', () => {
    const [finding] = validateDocument(
      doc([{ temporal: ['s1x :before s1y', 's1y :before s1x'] }]),
    ).filter((f) => f.code === 'temporal-mismatch');
    assert.equal(finding.level, 'error');
    assert.equal(finding.var, 's1y');
    assert.equal(
      finding.message,
      "The temporal relations contradict each other: they give both 's1y :after s1x' (from (s1x :before s1y)) and 's1y :before s1x' (from (s1y :before s1x)).",
    );
  });

  test('a consistent chain across sentences is fine', () => {
    assert.deepEqual(
      mismatches(
        doc([
          { temporal: ['document-creation-time :before s1x', 's1x :before s1y'] },
          { temporal: ['s1y :before s2x', 's2x :after s1x', 's2x :before s2y'] },
        ]),
      ),
      [],
    );
  });

  test('a cycle over three sentences', () => {
    assert.deepEqual(
      mismatches(
        doc([
          { temporal: ['document-creation-time :before s1x', 's1x :before s1y'] },
          { temporal: ['s1y :before s2x', 's2x :before s2y'] },
          { temporal: ['s2y :before s3x', 's3x :before s1x', 's3x :before s3y'] },
        ]),
      ),
      [
        [3, 's3x', ':after', ':before', 's1x'],
        [3, 's1x', ':before', ':after', 's3x'],
        [3, 's3x', ':after', ':before', 's1y'],
        [3, 's1y', ':before', ':after', 's3x'],
        [3, 's1x', ':before', ':after', 's1y'],
        [3, 's1y', ':after', ':before', 's1x'],
        [3, 's3x', ':after', ':before', 's2x'],
        [3, 's2x', ':before', ':after', 's3x'],
        [3, 's1x', ':before', ':after', 's2x'],
        [3, 's2x', ':after', ':before', 's1x'],
        [3, 's3x', ':after', ':before', 's2y'],
        [3, 's2y', ':before', ':after', 's3x'],
        [3, 's1x', ':before', ':after', 's2y'],
        [3, 's2y', ':after', ':before', 's1x'],
      ],
    );
  });

  test('coreferent events are one point in time', () => {
    assert.deepEqual(
      mismatches(
        doc([
          { temporal: ['document-creation-time :before s1x', 's1x :before s1y'] },
          { temporal: ['s1y :before s2x', 's2y :before s2x'], coref: ['s1x :same-event s2x'] },
        ]),
      ),
      [
        [2, 's1y', ':after', ':before', 's2x'],
        [2, 's2x', ':before', ':after', 's1y'],
        [2, 's1y', ':after', ':before', 's1x'],
        [2, 's1x', ':before', ':after', 's1y'],
        [2, 's2x', 'corefers with', ':after', 's1x'],
        [2, 's1x', 'corefers with', ':before', 's2x'],
      ],
    );
  });

  test('containment carries before and after inward', () => {
    assert.deepEqual(
      mismatches(
        doc([
          { temporal: ['document-creation-time :contains s1x', 's1y :contained s1x'] },
          { temporal: ['s1x :before s2x', 's2x :before s1y', 's2y :contained s2x'] },
          {
            temporal: [
              's3x :contained s3y',
              's3y :contained s3x',
              's3x :overlap s1x',
              's1x :after s3x',
            ],
          },
        ]),
      ),
      [
        [2, 's1y', ':contained', ':after', 'document-creation-time'],
        [2, 'document-creation-time', ':contains', ':before', 's1y'],
        [2, 's2x', ':after', ':before', 'document-creation-time'],
        [2, 'document-creation-time', ':before', ':after', 's2x'],
        [2, 's1y', ':contained', ':after', 's1x'],
        [2, 's1x', ':contains', ':before', 's1y'],
        [2, 's2x', ':after', ':before', 's1x'],
        [2, 's1x', ':before', ':after', 's2x'],
        [3, 's3y', ':contains', ':contained', 's3x'],
        [3, 's3x', ':contained', ':contains', 's3y'],
        [3, 's1x', ':overlap', ':after', 's3x'],
        [3, 's3x', ':overlap', ':before', 's1x'],
      ],
    );
  });

  test('overlap against before and after, each collision reported as validate.py does', () => {
    assert.deepEqual(
      mismatches(
        doc([
          {
            temporal: ['document-creation-time :before s1x', 's1x :overlap s1y', 's1y :after s1x'],
          },
          {
            temporal: [
              's2x :after s2y',
              's2x :overlap s2y',
              's2y :overlap s2x',
              's1x :depends-on s2x',
            ],
          },
        ]),
      ),
      [
        [1, 's1y', ':overlap', ':after', 's1x'],
        [1, 's1x', ':overlap', ':before', 's1y'],
        [2, 's2x', ':after', ':overlap', 's2y'],
        [2, 's2y', ':before', ':overlap', 's2x'],
        [2, 's2y', ':before', ':overlap', 's2x'],
        [2, 's2x', ':after', ':overlap', 's2y'],
      ],
    );
  });

  test('a node before itself, and a node never defined', () => {
    assert.deepEqual(
      mismatches(
        doc([
          {
            temporal: [
              's1x :before s1x',
              's9z :before s1y',
              's1y :before s9z',
              'document-creation-time :before s1y',
            ],
          },
        ]),
      ),
      [
        [1, 's1x', ':before', ':after', 's1x'],
        [1, 's1y', ':after', ':before', 's9z'],
        [1, 's9z', ':before', ':after', 's1y'],
      ],
    );
  });
});
