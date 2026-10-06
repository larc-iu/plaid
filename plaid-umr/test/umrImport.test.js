// What an import makes of a file and what its report says: a graph kept as
// text whatever broke it, and a report that names each sentence and counts
// what repeats.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import {
  importTarget,
  importUmrDocument,
  planImport,
  readerNotes,
} from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { getUmrLayerInfo } from '../src/utils/umrLayerUtils.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

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

test('a node named like a document graph is kept and reported', () => {
  // `s1s0` is what the export calls sentence 1's document-level block, and
  // the editors refuse the name, so the import says so and keeps the node.
  const warnings = [];
  const plan = planImport(
    parseUmrFile(
      file(CAT, {
        graph: '(s2s / sleep-01\n    :ARG0 (s1s0 / cat))',
        alignment: 's2s: 3-3\ns1s0: 2-2',
      }),
    ).sentences,
    warnings,
  );
  assert.deepEqual(
    warnings.filter((w) => /document graph/.test(w)),
    ['Sentence 2: s1s0 names the document graph of sentence 1. Rename the node.'],
  );
  assert.ok(plan.nodes.some((n) => n.key === '2:s1s0'));
});

// umr-import-repeat-file: a document of the file's name that already has a
// graph refuses a repeated import, one with words and no graph takes the
// file's graphs, and one with no words leaves the file a new document with a
// note.
describe("the project's document of the file's name", () => {
  const rawOf = (...sentences) =>
    rawFromPlan(planImport(parseUmrFile(file(...sentences)).sentences, []));

  test('with a graph, the import refuses', () => {
    assert.throws(() => importTarget(rawOf(CAT)), { message: '"doc" already has a graph.' });
  });

  test('with only a graph kept as text, the import refuses too', () => {
    const raw = rawOf({ graph: '((s1s / sleep-01)', alignment: 's1s: 3-3' });
    assert.throws(() => importTarget(raw), { message: '"doc" already has a graph.' });
  });

  test('with words and no graph, the file goes onto its words', () => {
    assert.deepEqual(importTarget(rawOf({})), { into: 'doc' });
  });

  test('with no words, the file is a new document with a note', () => {
    const raw = rawOf({});
    raw.textLayers[0].tokenLayers.find((tl) => tl.config.plaid?.role === 'word').tokens = [];
    const target = importTarget(raw);
    assert.equal(target.into, null);
    assert.equal(target.note, '"doc" has no words.');
  });
});

// Onto an existing document (an IGT text), the body is the sentence's text:
// the file's Sentence line is not stored beside it, where it would go stale.
test('an attach keeps no copy of the text the document already has', () => {
  const text = file({}).replace(
    'Words: the cat sleeps',
    'Words: the cat sleeps\nSentence: The cat sleeps.',
  );
  const parsed = parseUmrFile(text);
  assert.equal(parsed.sentences[0].sentenceText, 'The cat sleeps.');
  assert.equal(planImport(parsed.sentences, []).sentences[0].meta.text, 'The cat sleeps.');
  const existing = {
    sentences: [
      {
        begin: 0,
        end: 16,
        words: ['the', 'cat', 'sleeps'].map((w, i) => ({
          index: i + 1,
          begin: 0,
          end: 1,
          text: w,
        })),
        triples: [],
      },
    ],
    constants: [],
    nodesById: new Map(),
  };
  const plan = planImport(parsed.sentences, [], { existing });
  assert.equal(plan.sentences[0].meta.text, undefined);
  assert.ok(!plan.sentences[0].meta.ilg.some((l) => l.key === 'sentence'));
});

// Core keeps what an operation of kind import writes as the file has it,
// a cycle of relations included (`acyclic` exempts it), so every caller of
// the import writes under one, not only the Import page.
test('an import is one operation of kind import, whoever calls it', async () => {
  const seen = [];
  const client = {
    withOperation: async (label, fn, opts) => {
      seen.push({ label, ...opts });
      return fn(() => {});
    },
  };
  await assert.rejects(
    importUmrDocument(client, 'p', 'english', 'x', { isConfigured: false }),
    /not set up for UMR/,
  );
  assert.deepEqual(seen, [
    { label: 'Import UMR document "english"', kind: 'import', ref: 'format:umr' },
  ]);
});

// N3-IMPORT-OVER-3: attaching a file onto a document that holds a triple
// between two constants the file leaves out kept the relation stored and
// dropped it from the sentence's record, so nothing showed it and no export
// wrote it. The document wins: the record keeps listing it.
describe('an attach onto a document with a triple between constants', () => {
  const MODAL = { doc: '(s1s0 / sentence\n    :modal ((root :modal author)))' };
  const holder = () => {
    const raw = rawFromPlan(planImport(parseUmrFile(file(MODAL)).sentences, []));
    const doc = new UmrDocument({ raw });
    const [tripleId] = doc.graph.records[0].record.triples;
    return { raw, doc, tripleId };
  };

  test('the file leaving it out keeps it listed in its sentence', () => {
    const { doc, tripleId } = holder();
    assert.ok(tripleId);
    const plan = planImport(parseUmrFile(file({})).sentences, [], { existing: doc.graph });
    assert.deepEqual(plan.sentences[0].triples, [tripleId]);
    assert.equal(plan.triples.length, 0);
  });

  test('the file restating it lists it once', () => {
    const { doc, tripleId } = holder();
    const plan = planImport(parseUmrFile(file(MODAL)).sentences, [], { existing: doc.graph });
    assert.deepEqual(plan.sentences[0].triples, [tripleId]);
  });

  // REV-N5-APPS R4: a file that moves the triple to another sentence's block
  // had it listed in both records, and every export wrote it twice.
  test('the file moving it to another sentence lists it there only', () => {
    const raw = rawFromPlan(planImport(parseUmrFile(file(MODAL, {})).sentences, []));
    const doc = new UmrDocument({ raw });
    const [tripleId] = doc.graph.records[0].record.triples;
    const plan = planImport(parseUmrFile(file({}, MODAL)).sentences, [], {
      existing: doc.graph,
    });
    assert.deepEqual(
      plan.sentences.map((s) => s.triples),
      [[], [tripleId]],
    );
  });

  test('the export still writes it after the record is replaced', () => {
    const { raw, doc } = holder();
    const plan = planImport(parseUmrFile(file({})).sentences, [], { existing: doc.graph });
    // What the import writes onto the record: the file's lines and the list.
    const after = structuredClone(raw);
    const nodeLayer = after.textLayers[0].tokenLayers.find((tl) =>
      tl.tokens.some((t) => t.id === doc.graph.records[0].id),
    );
    const record = nodeLayer.tokens.find((t) => t.id === doc.graph.records[0].id);
    record.metadata.umr = { ...plan.sentences[0].meta, triples: plan.sentences[0].triples };
    assert.match(new UmrDocument({ raw: after }).toUmr(), /:modal \(\(root :modal author\)\)/);
  });
});

// Every anchor an import makes goes in the request that makes the node on
// it, so no anchor is ever stored without its node, whatever cuts the import
// off after it.
test('an import makes its anchors and the nodes on them in one request', async () => {
  const text = file({
    words: 'the cat sleeps',
    graph: '(s1s / sleep-01\n    :ARG0 (s1c / cat))',
    alignment: 's1s: 3-3\ns1c: 2-2',
    doc: '(s1s0 / sentence)',
  });
  const raw = rawFromPlan(planImport(parseUmrFile(text).sentences, []));
  const nodes = raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
  nodes.tokens = [];
  nodes.spanLayers[0].spans = [];
  nodes.spanLayers[0].relationLayers.forEach((l) => (l.relations = []));
  const { client, calls } = recordingClient();
  client.documents.get = async () => structuredClone(raw);
  const sent = [];
  const batched = client.batched;
  client.batched = async (fn) => {
    const from = calls.length;
    try {
      return await batched(fn);
    } finally {
      sent.push(calls.slice(from).map((c) => c.name));
    }
  };
  const { attached } = await importUmrDocument(client, 'p', 'doc', text, getUmrLayerInfo(raw), {
    into: raw.id,
  });
  assert.ok(attached);
  const anchors = sent.findIndex((names) => names.includes('tokens.bulkCreate'));
  assert.ok(sent[anchors].includes('spans.bulkCreate'), JSON.stringify(sent));
  assert.equal(sent.flat().filter((n) => n === 'spans.bulkCreate').length, 1);
  // The nodes name their anchors by the ids the import made them under.
  const pieces = calls.find((c) => c.name === 'tokens.bulkCreate').args[0];
  const spans = calls.find((c) => c.name === 'spans.bulkCreate').args[0];
  const pieceIds = new Set(pieces.map((p) => p.id));
  assert.ok(spans.every((s) => s.tokens.every((id) => pieceIds.has(id))));
});
