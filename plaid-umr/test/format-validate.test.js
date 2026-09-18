import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { validateSentence, validateDocument } from '../src/domain/format/validate.js';

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
