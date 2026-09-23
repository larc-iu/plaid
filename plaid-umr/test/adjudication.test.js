import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markVariables,
  percent,
  readAdjudication,
  scoreRows,
  sentenceMarks,
  sentenceReport,
} from '../src/domain/adjudication.js';
import { compareNotice } from '../src/domain/compareNotice.js';

const report = {
  version: 4,
  tool: 'ancast 0.1.1',
  against: { id: 'd2', name: 'Copy' },
  at: '2026-09-19T20:00:00Z',
  scope: 'doc',
  scores: { sentence: 0.8312, modal: 0.5, temporal: null, coref: 1, comprehensive: 0.7 },
  sentences: [
    {
      index: 1,
      concept: 0.9,
      labeled: 0.8,
      unlabeled: 0.85,
      weighted: 0.8,
      smatch: 0.7,
      matches: [
        {
          this: 's1l',
          other: 's1x0',
          thisConcept: 'leave-02',
          otherConcept: 'leave-11',
          leftover: false,
        },
        {
          this: 's1e',
          other: 's1x1',
          thisConcept: 'eat-01',
          otherConcept: 'eat-01',
          leftover: true,
        },
      ],
      unmatched: ['s1p'],
      unmatchedOther: [],
      skipped: null,
    },
  ],
};

// The report as the service stores it: the summary on the document and each
// row on its sentence token, a match as a list.
const storedMatch = (m) => [m.this, m.other, m.thisConcept, m.otherConcept, m.leftover];
const stored = (r) => {
  const { sentences, ...summary } = r;
  return {
    raw: { metadata: { umr: { adjudication: { ...summary, sentenceCount: sentences.length } } } },
    tokens: sentences.map((row, i) => ({
      id: `snt-${i + 1}`,
      begin: i * 10,
      metadata: {
        umr: {
          lang: 'eng',
          adjudication: { ...row, matches: row.matches.map(storedMatch), at: r.at },
        },
      },
    })),
  };
};

test('the report is read from the document and its sentences, or not at all', () => {
  const { raw, tokens } = stored(report);
  const read = readAdjudication(raw, tokens);
  assert.equal(read.version, 4);
  assert.deepEqual(read.scores, report.scores);
  assert.deepEqual(read.against, report.against);
  assert.deepEqual(read.sentences, [{ ...report.sentences[0], at: report.at }]);
  assert.equal(sentenceReport(read, 1).concept, 0.9);
  // The tokens in any order: a row's index is its sentence's place in the text.
  assert.equal(readAdjudication(raw, [...tokens].reverse()).sentences[0].index, 1);
  // A report of another shape is not read as this one, the old whole report
  // included.
  const whole = { metadata: { umr: { adjudication: { ...report, version: 2 } } } };
  assert.equal(
    readAdjudication(
      { metadata: { umr: { adjudication: { ...raw.metadata.umr.adjudication, version: 3 } } } },
      tokens,
    ),
    null,
  );
  assert.equal(readAdjudication(whole, tokens), null);
  assert.equal(readAdjudication({ metadata: {} }), null);
  assert.equal(readAdjudication(null), null);
});

test("a sentence row from an earlier run is not part of this run's report", () => {
  const { raw, tokens } = stored(report);
  const earlier = tokens.map((t) => ({
    ...t,
    metadata: {
      umr: { adjudication: { ...t.metadata.umr.adjudication, at: '2026-01-01T00:00:00Z' } },
    },
  }));
  assert.deepEqual(readAdjudication(raw, earlier).sentences, []);
  assert.deepEqual(readAdjudication(raw, [{ id: 'x', begin: 0 }]).sentences, []);
});

test('scores print as whole percents and a missing one is not a row', () => {
  assert.equal(percent(0.8312), '83%');
  assert.equal(percent(null), 'n/a');
  // Temporal is null: neither document annotates it, a row saying so.
  assert.deepEqual(
    scoreRows(report).map((r) => [r.key, r.value]),
    [
      ['sentence', 0.8312],
      ['modal', 0.5],
      ['temporal', null],
      ['coref', 1],
      ['comprehensive', 0.7],
    ],
  );
  assert.deepEqual(
    scoreRows({ ...report, scope: 'snt' }).map((r) => r.key),
    ['sentence'],
  );
  assert.equal(sentenceReport(report, 1).concept, 0.9);
  assert.equal(sentenceReport(report, 2), null);
});

test('marking variables cuts whole tokens only', () => {
  const text = '(s1l / leave-02\n    :ARG0 (s1p / person)\n    :ARG1 s1p2)';
  const segs = markVariables(text, new Map([['s1p', 'missing']]));
  assert.deepEqual(
    segs.filter((s) => s.mark).map((s) => [s.text, s.mark]),
    [['s1p', 'missing']],
  );
  assert.equal(segs.map((s) => s.text).join(''), text);
  assert.deepEqual(markVariables(text, new Map()), [{ text, mark: null }]);
  // A variable made from a concept in another script is one too.
  const cyrillic = '(s1д / дом-01 :ARG0 (s2ł / łódź))';
  const marked = markVariables(
    cyrillic,
    new Map([
      ['s1д', 'differs'],
      ['s2ł', 'missing'],
    ]),
  );
  assert.deepEqual(
    marked.filter((x) => x.mark).map((x) => [x.text, x.mark]),
    [
      ['s1д', 'differs'],
      ['s2ł', 'missing'],
    ],
  );
  assert.deepEqual(markVariables('', new Map([['s1p', 'missing']])), []);
});

// A pair whose concepts differ is a disagreement on both sides. A leftover
// pair of one concept is not marked: the pairing may be arbitrary, but the
// two graphs agree on what is there.
test('each side marks what has no counterpart and what differs in concept', () => {
  const { mine, theirs } = sentenceMarks(report.sentences[0]);
  assert.deepEqual(
    [...mine],
    [
      ['s1p', 'missing'],
      ['s1l', 'differs'],
    ],
  );
  assert.deepEqual([...theirs], [['s1x0', 'differs']]);
  assert.deepEqual([...sentenceMarks(null).mine], []);
});

test('the notice says the scores and the other document, or warns', () => {
  assert.deepEqual(compareNotice({ scores: report.scores, against: report.against }), {
    level: 'success',
    title: 'Compared with Copy',
    message: 'Sentence graphs 83%, comprehensive 70%.',
  });
  assert.equal(compareNotice({}).level, 'warning');
  assert.equal(
    compareNotice({ notice: { level: 'success', title: 'T', message: 'M' } }).title,
    'T',
  );
});
