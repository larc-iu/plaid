// What an import makes of a file and what its report says: a graph kept as
// text whatever broke it, and a report that names each sentence and counts
// what repeats.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport, readerNotes } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';

const SEPARATOR = '#'.repeat(80);

// A file of sentences, each `{ words, graph, alignment, doc, header }`.
const file = (...sentences) =>
  sentences
    .map(({ words = 'the cat sleeps', graph = '', alignment = '', doc = '', header }, i) =>
      [
        SEPARATOR,
        `# :: snt${i + 1}`,
        `Index: ${words
          .split(' ')
          .map((_, k) => k + 1)
          .join(' ')}`,
        `Words: ${words}`,
        ...(header ? [header] : []),
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
      ].join('\n'),
    )
    .join('');

const CAT = { graph: '(s1s / sleep-01\n    :ARG0 (s1c / cat))', alignment: 's1s: 3-3\ns1c: 2-2' };

describe('a graph the reader cannot parse', () => {
  test('with no root to be found, it is still kept as text and written back', () => {
    // A doubled opening bracket: the parser finds no variable, so no root.
    const broken = '((s2d / sleep-01\n    :ARG0 (s2c / cat))';
    const parsed = parseUmrFile(file(CAT, { graph: broken, alignment: 's2d: 3-3\ns2c: 2-2' }));
    assert.equal(parsed.sentences[1].graph.root, null);
    const warnings = [];
    const plan = planImport(parsed.sentences, warnings);
    assert.equal(plan.sentences[1].meta.rawGraph, broken);
    assert.equal(plan.sentences[1].meta.rawAlignment, 's2d: 3-3\ns2c: 2-2');
    assert.ok(warnings.some((w) => /^Sentence 2: unreadable graph, stored as text/.test(w)));
    // It has a graph, one kept as text, so it is not counted as having none.
    assert.ok(!warnings.some((w) => /no graph/.test(w)), warnings.join('\n'));

    const umr = new UmrDocument({ raw: rawFromPlan(plan) }).toUmr();
    assert.ok(umr.includes(`# sentence level graph:\n${broken}\n`));
    assert.ok(umr.includes('# alignment:\ns2d: 3-3\ns2c: 2-2\n'));
  });

  test('a sentence with no graph at all is counted as one', () => {
    const warnings = [];
    planImport(parseUmrFile(file(CAT, {})).sentences, warnings);
    assert.ok(warnings.includes('1 sentence has no graph.'), warnings.join('\n'));
  });
});

describe('a document-level triple with an end no node has', () => {
  test('the report names the whole triple, as dropped', () => {
    const warnings = [];
    const plan = planImport(
      parseUmrFile(
        file({ ...CAT, doc: '(s1s0 / sentence\n    :temporal ((override :before s1s)))' }),
      ).sentences,
      warnings,
    );
    assert.deepEqual(
      warnings.filter((w) => /dropped/.test(w)),
      ['Sentence 1: (override :before s1s) dropped, no node override.'],
    );
    assert.equal(plan.triples.length, 0);
  });

  test('both ends missing are both named, once each', () => {
    const warnings = [];
    planImport(
      parseUmrFile(
        file({
          ...CAT,
          doc: '(s1s0 / sentence\n    :coref ((s9x :same-entity s9y)\n        (s9x :same-entity s9x)))',
        }),
      ).sentences,
      warnings,
    );
    assert.deepEqual(
      warnings.filter((w) => /dropped/.test(w)),
      [
        'Sentence 1: (s9x :same-entity s9y) dropped, no node s9x or s9y.',
        'Sentence 1: (s9x :same-entity s9x) dropped, no node s9x.',
      ],
    );
  });
});

describe('the reader’s notes in the import report', () => {
  test('each names its sentence, and one made in many sentences is one counted line', () => {
    const obsolete = { ...CAT, header: 'tr: a translation' };
    const parsed = parseUmrFile(file(obsolete, obsolete, obsolete, CAT));
    const notes = readerNotes(parsed);
    assert.deepEqual(
      notes.filter((n) => /tr'/.test(n)),
      ["3 sentences: Obsolete interlinear glossing header 'tr'."],
    );
    const once = readerNotes(parseUmrFile(file(CAT, obsolete)));
    assert.deepEqual(
      once.filter((n) => /tr'/.test(n)),
      ["Sentence 2: Obsolete interlinear glossing header 'tr'."],
    );
  });

  test('a parse error is left to the unreadable-graph line of its sentence', () => {
    const parsed = parseUmrFile(file(CAT, { graph: '(s2s / sleep-01 / x)' }));
    assert.ok(parsed.errors.length);
    const notes = readerNotes(parsed);
    assert.ok(!notes.some((n) => /Expected/.test(n)), notes.join('\n'));
    const warnings = [];
    planImport(parsed.sentences, warnings);
    assert.equal(warnings.filter((w) => /Expected/.test(w)).length, 1);
    assert.match(
      warnings.find((w) => /Expected/.test(w)),
      /^Sentence 2: unreadable graph/,
    );
  });

  test('a note about the whole file has no sentence', () => {
    const notes = readerNotes(parseUmrFile(`preamble\n${file(CAT)}`));
    assert.ok(notes.includes('Content before the first sentence separator was ignored.'), notes);
  });
});

describe('text in NFC', () => {
  const composed = 'caf\u00e9';
  const decomposed = 'cafe\u0301';

  test('a file written with combining accents is read composed', () => {
    const parsed = parseUmrFile(
      file({
        words: `the ${decomposed} opens`,
        graph: `(s1o / open-01\n    :ARG1 (s1c / ${decomposed}))`,
        alignment: 's1o: 3-3\ns1c: 2-2',
      }),
    );
    assert.equal(parsed.sentences[0].words[1], composed);
    assert.equal(parsed.sentences[0].graph.nodes.get('s1c').concept, composed);
  });

  test('onto a document whose text has combining accents, the words still match', () => {
    const words = `the ${composed} opens`;
    const sentences = parseUmrFile(file({ words })).sentences;
    // A document whose body holds the accent as a combining character.
    const nfd = sentences.map((s) => ({ ...s, words: s.words.map((w) => w.normalize('NFD')) }));
    const existing = new UmrDocument({ raw: rawFromPlan(planImport(nfd, [])) }).graph;
    assert.equal(existing.sentences[0].words[1].text, decomposed);
    assert.doesNotThrow(() =>
      planImport(parseUmrFile(file({ words, ...CAT })).sentences, [], { existing }),
    );
  });
});

test('a note the reader makes per node is said once per sentence', () => {
  const spaced = { ...CAT, alignment: 's1s : 3-3\ns1c : 2-2' };
  const notes = readerNotes(parseUmrFile(file(spaced, spaced)));
  assert.deepEqual(
    notes.filter((n) => /colon/.test(n)),
    ['2 sentences: Alignment lines have a space before the colon.'],
  );
});
