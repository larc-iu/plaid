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

// The report as the service stores it (R33): each row on its sentence's
// record, the summary on the first sentence's record beside its row, a match
// as a list. `sentences` are the document's sentences as buildDocumentGraph
// reads them, each naming its own record.
const storedMatch = (m) => [m.this, m.other, m.thisConcept, m.otherConcept, m.leftover];
const stored = (r) => {
  const { sentences, ...summary } = r;
  const nodeTokens = sentences.map((row, i) => ({
    id: `rec-${i + 1}`,
    begin: i * 10,
    metadata: {
      umr: {
        snt: String(i + 1),
        adjudication: { ...row, matches: row.matches.map(storedMatch), at: r.at },
        ...(i === 0
          ? { adjudicationSummary: { ...summary, sentenceCount: sentences.length } }
          : {}),
      },
    },
  }));
  // An anchor of a node, which is no record.
  nodeTokens.push({ id: 'anchor', begin: 0, end: 3 });
  return { nodeTokens, sentences: sentences.map((_, i) => ({ recordToken: `rec-${i + 1}` })) };
};

const withSummary = (nodeTokens, change) =>
  nodeTokens.map((t) =>
    t.metadata?.umr?.adjudicationSummary
      ? {
          ...t,
          metadata: {
            umr: {
              ...t.metadata.umr,
              adjudicationSummary: change(t.metadata.umr.adjudicationSummary),
            },
          },
        }
      : t,
  );

test('the report is read from the records, or not at all', () => {
  const { nodeTokens, sentences } = stored({ ...report, version: 5 });
  const read = readAdjudication(nodeTokens, sentences);
  assert.equal(read.version, 5);
  assert.deepEqual(read.scores, report.scores);
  assert.deepEqual(read.against, report.against);
  assert.deepEqual(read.sentences, [{ ...report.sentences[0], at: report.at }]);
  assert.equal(sentenceReport(read, 1).concept, 0.9);
  // A row's index is its sentence's place in the text, whatever it stored.
  assert.equal(
    readAdjudication(nodeTokens, [{ recordToken: 'x' }, ...sentences]).sentences[0].index,
    2,
  );
  // A report of another shape is not read as this one: version 4 was on the
  // document and the sentence tokens.
  assert.equal(
    readAdjudication(
      withSummary(nodeTokens, (s) => ({ ...s, version: 4 })),
      sentences,
    ),
    null,
  );
  assert.equal(readAdjudication([], sentences), null);
  assert.equal(readAdjudication(undefined, undefined), null);
});

test("a sentence row from an earlier run is not part of this run's report", () => {
  const { nodeTokens, sentences } = stored({ ...report, version: 5 });
  const later = withSummary(nodeTokens, (s) => ({ ...s, at: '2027-01-01T00:00:00Z' }));
  assert.deepEqual(readAdjudication(later, sentences).sentences, []);
  assert.deepEqual(readAdjudication(nodeTokens, [{ recordToken: 'x' }]).sentences, []);
});

test('of two summaries (a sentence merged since), the latest run is read', () => {
  const { nodeTokens, sentences } = stored({ ...report, version: 5 });
  const older = {
    id: 'rec-old',
    begin: 1,
    metadata: {
      umr: { adjudicationSummary: { version: 5, at: '2026-01-01T00:00:00Z', scores: {} } },
    },
  };
  assert.equal(readAdjudication([older, ...nodeTokens], sentences).at, report.at);
  assert.equal(readAdjudication([...nodeTokens, older], sentences).at, report.at);
});

test('scores print as percents, never 100% short of full agreement, and a missing one is not a row', () => {
  assert.equal(percent(0.8312), '83%');
  // Only full agreement is 100%, and only none is 0%.
  assert.equal(percent(1), '100%');
  assert.equal(percent(0.9986), '99.9%');
  assert.equal(percent(0.99999), '99.9%');
  assert.equal(percent(0.995), '99.5%');
  assert.equal(percent(0.994), '99%');
  assert.equal(percent(0), '0%');
  assert.equal(percent(0.004), '0.4%');
  assert.equal(percent(0.00001), '0.1%');
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
  assert.deepEqual(
    compareNotice({
      scores: report.scores,
      against: report.against,
      sentencesScored: 2,
      sentencesSkipped: 0,
    }),
    {
      level: 'success',
      title: 'Compared with Copy',
      message: 'Sentence graphs 83%, comprehensive 70%. Scored 2 sentences.',
    },
  );
  assert.equal(
    compareNotice({ scores: report.scores, sentencesScored: 1, sentencesSkipped: 1 }).message,
    'Sentence graphs 83%, comprehensive 70%. Scored 1 sentence. Could not read 1 sentence.',
  );
  // Only what was scored is named.
  assert.equal(
    compareNotice({ scores: { sentence: 0.5, comprehensive: null }, sentencesScored: 1 }).message,
    'Sentence graphs 50%. Scored 1 sentence.',
  );
  assert.deepEqual(compareNotice({ scores: {}, sentencesScored: 0, sentencesSkipped: 3 }), {
    level: 'warning',
    title: 'Nothing scored',
    message: 'Could not read a graph in any of the 3 sentences.',
  });
  assert.equal(compareNotice({}).level, 'warning');
  // A notice text a result carries is not shown: the words are the app's.
  assert.equal(
    compareNotice({ notice: { level: 'success', title: 'T', message: 'M' } }).title,
    'Nothing scored',
  );
  // Two documents that differ never read as 100%, in the notice as on the tab.
  assert.match(
    compareNotice({ scores: { sentence: 0.9986, comprehensive: 1 } }).message,
    /^Sentence graphs 99\.9%, comprehensive 100%/,
  );
  // A half rounds up, as the tab prints it.
  assert.match(
    compareNotice({ scores: { sentence: 0.825, comprehensive: 0.125 } }).message,
    /^Sentence graphs 83%, comprehensive 13%/,
  );
});
