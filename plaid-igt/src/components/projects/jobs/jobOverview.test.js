import { describe, it, expect } from 'vitest';
import {
  documentChecks,
  headlineFacts,
  headlineText,
  jobHeadline,
  jobSections,
  toCheckRows,
} from './jobOverview.js';

// The facts of a job that wrote, which each case changes a part of.
const WROTE = {
  state: 'done',
  sentences: 1354,
  changes: 1354,
  changedDocuments: 129,
  documents: 130,
  harmonized: 0,
  oneStep: false,
  findings: false,
};
const NOTHING = { ...WROTE, sentences: 0, changes: 0, changedDocuments: 0 };

describe('the headline', () => {
  it.each([
    ['a job that wrote', WROTE, 'Changed 1,354 sentences in 129 of 130 documents.'],
    [
      'one sentence in one document',
      { ...WROTE, sentences: 1, changes: 1, changedDocuments: 1, documents: 1 },
      'Changed 1 sentence in 1 of 1 document.',
    ],
    [
      'a job worked in one step',
      { ...WROTE, sentences: 33, changes: 33, changedDocuments: 24, documents: 45, oneStep: true },
      'Changed 33 sentences in 24 of 45 documents in one step.',
    ],
    ['a job that wrote nothing', { ...NOTHING, documents: 3 }, 'Changed nothing.'],
    [
      'a job that fills nothing',
      { ...NOTHING, findings: true },
      'Wrote findings, changed nothing.',
    ],
    [
      'a stopped job',
      { ...WROTE, state: 'cancelled', sentences: 3, changedDocuments: 1, documents: 5 },
      'Changed 3 sentences in 1 of 5 documents, then stopped.',
    ],
    [
      'a job stopped before it wrote',
      { ...NOTHING, state: 'cancelled' },
      'Stopped before changing anything.',
    ],
    [
      'a job that failed before it wrote',
      { ...NOTHING, state: 'failed' },
      'Failed before changing anything.',
    ],
    [
      'a job that failed after it wrote',
      { ...WROTE, state: 'failed', sentences: 2, changedDocuments: 1, documents: 2 },
      'Changed 2 sentences in 1 of 2 documents, then failed.',
    ],
    [
      'an undone job',
      { ...WROTE, state: 'undone', sentences: 21, changedDocuments: 3, documents: 3 },
      'Changed 21 sentences in 3 of 3 documents, then undone.',
    ],
    ['a job that wrote in the lexicon only', { ...NOTHING, changes: 4 }, 'Made 4 changes.'],
    [
      'a job whose changes are in no sentence',
      { ...NOTHING, changes: 4, changedDocuments: 2, documents: 3 },
      'Made 4 changes in 2 of 3 documents.',
    ],
    [
      'a job that only made analyses consistent',
      { ...NOTHING, harmonized: 2 },
      'Made 2 forms consistent.',
    ],
    [
      'a check stopped partway',
      { ...NOTHING, state: 'cancelled', findings: true },
      'Wrote findings, then stopped.',
    ],
  ])('%s', (_, facts, said) => {
    expect(headlineText(facts)).toBe(said);
  });

  it('reads its facts from the job: the totals, the documents changed, harmonize and the undo', () => {
    const job = {
      state: 'done',
      undone: { time: '2026-11-12T12:00:00Z', user: 'm' },
      documents: [{ documentId: 'd1' }, { documentId: 'd2' }, { documentId: 'd3' }],
      report: {
        totals: { sentences: 4, changes: 6 },
        documents: [
          { documentId: 'd1', state: 'done', counts: { changes: 6, oneStep: true } },
          { documentId: 'd2', state: 'done', counts: { changes: 0, oneStep: true } },
          { documentId: 'd3', state: 'in-use', counts: {} },
        ],
        harmonize: { changed: [{ form: 'ka' }], changedMore: 2 },
      },
    };
    expect(headlineFacts(job)).toEqual({
      state: 'undone',
      sentences: 4,
      changes: 6,
      changedDocuments: 1,
      documents: 3,
      harmonized: 3,
      oneStep: true,
      findings: false,
    });
    expect(jobHeadline(job)).toBe(
      'Changed 4 sentences in 1 of 3 documents in one step, then undone.',
    );
  });

  it('counts the changes from the documents where the totals hold none', () => {
    const job = {
      state: 'cancelled',
      documents: [{ documentId: 'd1' }],
      report: { totals: {}, documents: [{ documentId: 'd1', counts: { changes: 2 } }] },
    };
    expect(jobHeadline(job)).toBe('Made 2 changes in 1 of 1 document, then stopped.');
  });
});

// A report with one of everything a person checks.
const reportOf = (over = {}) => ({
  totals: {
    skippedTooLong: 5,
    skippedFailed: 0,
    skippedNoAnswer: 1,
    peoplesValuesChanged: 33,
    blank: [
      {
        target: 'Translation',
        unit: 'sentence',
        left: 0,
        untouched: 192,
        notReached: 11,
        skipped: 5,
      },
      { target: 'Gloss', unit: 'morpheme', left: 6, unsegmented: 2, untouched: 0 },
    ],
  },
  documents: [
    {
      documentId: 'd1',
      name: 'Story A',
      state: 'done',
      counts: {
        peoplesValuesChanged: 33,
        leftUnits: [{ unit: 'morpheme', left: 6 }],
        blank: [
          { target: 'Translation', unit: 'sentence', left: 0, untouched: 150 },
          { target: 'Gloss', unit: 'morpheme', left: 6 },
        ],
      },
      refused: [{ sentence: 's2', sentenceId: 'x', code: 'not-added' }],
      refusedMore: 1,
    },
    {
      documentId: 'd2',
      name: 'Story B',
      state: 'done',
      counts: { blank: [{ target: 'Translation', unit: 'sentence', left: 0, untouched: 42 }] },
      leftUnread: true,
    },
    { documentId: 'd3', name: 'Story C', state: 'in-use', counts: {} },
    { documentId: 'd4', name: 'Story D', state: 'not-reached', done: 0, counts: {} },
    { documentId: 'd5', name: 'Story E', state: 'not-reached', done: 2, counts: {} },
  ],
  respelled: [{ ref: 's1.w1' }],
  respelledMore: 2,
  proposed: [{ label: 'rename' }, { field: 'Gloss', reason: 'interrupted' }],
  proposedMore: 2,
  harmonize: { left: [{ form: 'tsa' }], leftMore: 7 },
  entries: { unlinked: [{ id: 'e2' }], unlinkedMore: 2 },
  summaryFailed: true,
  ...over,
});

describe('what to check', () => {
  it('has a row per kind with a count, in the page’s words, each with the section that lists it', () => {
    const rows = toCheckRows({ state: 'done', report: reportOf() });
    expect(rows.map((r) => [r.text, r.view, r.filter ?? null])).toEqual([
      ['1 document in use, not worked', 'documents', 'in-use'],
      ['1 document not reached', 'documents', 'not-reached'],
      ['1 document stopped partway', 'documents', 'partway'],
      ['5 sentences skipped, too long', 'skipped', null],
      ['1 sentence skipped, no answer from the assistant', 'skipped', null],
      [
        '192 sentences with Translation blank in sentences the job did not change, in 2 documents',
        'blank',
        null,
      ],
      [
        '6 morphemes with Gloss left blank in sentences the job changed, in 1 document',
        'blank',
        null,
      ],
      ['2 words not segmented, Gloss left blank', 'blank', null],
      ['1 document could not be read', 'blank', null],
      ['2 changes not done, refused', 'blank', null],
      [
        '33 values, morphemes or links people wrote, changed or removed, in 1 document',
        'documents',
        'people',
      ],
      ['3 words respelled, analysis kept', 'respelled', null],
      ['3 changes proposed, not applied', 'proposed', null],
      ['1 change not written, the write was interrupted', 'proposed', null],
      ['8 forms left inconsistent', 'inconsistent', null],
      ['3 entries with no links', 'entries', null],
      ['The summary could not be written', null, null],
    ]);
  });

  it('has no row for a kind with nothing in it', () => {
    const rows = toCheckRows({
      state: 'done',
      report: {
        totals: { sentences: 3, changes: 3, blank: [{ target: 'Gloss', unit: 'word', left: 0 }] },
        documents: [{ documentId: 'd1', state: 'done', counts: { changes: 3 } }],
      },
    });
    expect(rows).toEqual([]);
  });

  it('counts the skipped sentences from the lists where the totals hold none', () => {
    const rows = toCheckRows({
      state: 'done',
      report: {
        totals: {},
        documents: [
          {
            documentId: 'd1',
            state: 'done',
            skipped: [
              { sentence: 's1', reason: 'changed' },
              { sentence: 's2', reason: 'changed' },
              { sentence: 's3', reason: 'interrupted' },
            ],
            counts: {},
          },
        ],
      },
    });
    expect(rows.map((r) => r.text)).toEqual([
      '2 sentences skipped, changed during the job',
      '1 sentence skipped after an interrupted write',
    ]);
  });

  // REV-RP-1: the sentences the worker moved past a document's list (or a
  // report too large for core) are counted under skippedMore, apart from
  // their reason's total.
  it('counts the skipped sentences not listed, so its rows add up to the Skipped section', () => {
    const job = {
      state: 'done',
      documents: [{ documentId: 'd1' }, { documentId: 'd2' }],
      report: {
        totals: { skippedTooLong: 2, skippedFailed: 1, skippedMore: 499 },
        documents: [
          {
            documentId: 'd1',
            state: 'done',
            skipped: [
              { sentence: 's1', reason: 'too-long' },
              { sentence: 's2', reason: 'failed' },
            ],
            counts: { skippedMore: 499 },
          },
          {
            documentId: 'd2',
            state: 'done',
            skipped: [{ sentence: 's4', reason: 'too-long' }],
            counts: {},
          },
        ],
      },
    };
    const rows = toCheckRows(job).filter((r) => r.view === 'skipped');
    expect(rows.map((r) => r.text)).toEqual([
      '2 sentences skipped, too long',
      '1 sentence skipped, failed',
      '499 sentences skipped and not listed',
    ]);
    const counted = rows.reduce((n, r) => n + Number(r.text.split(' ')[0].replace(/,/g, '')), 0);
    const tab = jobSections(job, null).find((s) => s.key === 'skipped');
    expect(counted).toBe(502);
    expect(tab.count).toBe(counted);
  });

  // REV-RP-4: core fails a job before its worker's report arrives, and the
  // job's own document rows still say which documents were not finished.
  it('builds the rows of documents from the job’s own rows for an ended job with no report', () => {
    const job = {
      state: 'failed',
      report: null,
      documents: [
        { documentId: 'd1', state: 'not-reached', done: 0, counts: { changes: 3 } },
        { documentId: 'd2', state: 'in-use', counts: {} },
        { documentId: 'd3', state: 'not-reached', done: 0, counts: {} },
        { documentId: 'd4', state: 'done', done: 4, counts: { changes: 1 } },
      ],
    };
    expect(toCheckRows(job).map((r) => [r.text, r.view, r.filter])).toEqual([
      ['1 document in use, not worked', 'documents', 'in-use'],
      ['1 document not reached', 'documents', 'not-reached'],
      ['1 document stopped partway', 'documents', 'partway'],
    ]);
    expect(toCheckRows({ state: 'failed', report: null, documents: [job.documents[3]] })).toEqual(
      [],
    );
  });
});

describe('a document’s reasons to check it', () => {
  it('says each reason in a few words', () => {
    const report = reportOf();
    const said = (d, r) => documentChecks(d, r).map((c) => c.text);
    const kinds = (d, r) => documentChecks(d, r).map((c) => c.kind);
    expect(said(report.documents[0])).toEqual([
      '6 morphemes left blank',
      'Translation blank in 150 sentences the job did not change',
      '33 values, morphemes or links people wrote, changed',
      '2 changes refused',
    ]);
    expect(kinds(report.documents[0])).toEqual(['left', 'untouched', 'people', 'refused']);
    expect(said(report.documents[2])).toEqual(['In use, not worked']);
    expect(kinds(report.documents[2])).toEqual(['in-use']);
    expect(kinds(report.documents[3])).toEqual(['not-reached']);
    expect(kinds(report.documents[4])).toEqual(['partway']);
  });

  it('reads the report’s row of the document, and has none for a document with nothing to check', () => {
    const row = { documentId: 'd1', state: 'done', counts: { changes: 2 } };
    expect(documentChecks(row)).toEqual([]);
    expect(
      documentChecks(row, {
        ...row,
        skipped: [{ sentence: 's1', reason: 'too-long' }],
        counts: { skippedMore: 2, blank: [], leftUnits: [] },
        leftUnread: true,
      }),
    ).toEqual([
      { kind: 'skipped', text: '3 sentences skipped' },
      { kind: 'unread', text: 'Could not be read' },
    ]);
  });
});

describe('the sections', () => {
  const keys = (list) => list.map((s) => (s.count === undefined ? s.key : `${s.key} ${s.count}`));

  it('draws an ended job’s lists that hold something, each with its count', () => {
    const job = {
      state: 'done',
      documents: [{ documentId: 'd1' }, { documentId: 'd2' }],
      report: {
        ...reportOf(),
        documents: [
          {
            documentId: 'd1',
            skipped: [{ sentence: 's1' }, { sentence: 's2' }],
            counts: { skippedMore: 1 },
            left: [{ ref: 's3.w1' }],
          },
        ],
        plan: { leftOut: [{ documentId: 'd2' }], leftOutMore: 1 },
        tables: [{ title: 'T' }],
        harmonize: { changed: [{ form: 'ka' }], left: [], leftMore: 7 },
        entries: { created: [{ id: 'e1' }], createdMore: 3, unlinked: [{ id: 'e1' }] },
      },
    };
    expect(keys(jobSections(job, 12))).toEqual([
      'overview',
      'documents 2',
      'notes 12',
      'blank',
      'skipped 3',
      'proposed 4',
      'entries 4',
      'respelled 3',
      'leftout 2',
      'tables 1',
      'consistent 1',
      'inconsistent 7',
      'setup',
    ]);
  });

  it('draws none of the lists of a job that has nothing in them, nor Notes before they are read', () => {
    const job = {
      state: 'done',
      documents: [{ documentId: 'd1' }],
      report: { totals: {}, documents: [{ documentId: 'd1', counts: {} }] },
    };
    expect(keys(jobSections(job, null))).toEqual(['overview', 'documents 1', 'setup']);
    expect(keys(jobSections(job, 0))).toEqual(['overview', 'documents 1', 'setup']);
    // An ended job with no report keeps its Notes.
    expect(keys(jobSections({ ...job, report: null }, 3))).toEqual([
      'overview',
      'documents 1',
      'notes 3',
      'setup',
    ]);
  });

  it('draws Entries for the machine drafts of a lexicon of the project', () => {
    const job = {
      state: 'done',
      documents: [],
      report: { entries: { lexicons: ['v1'] } },
    };
    expect(keys(jobSections(job, null, [{ id: 'v1', name: 'Lexicon' }]))).toEqual([
      'overview',
      'entries',
      'setup',
    ]);
    expect(keys(jobSections(job, null, []))).toEqual(['overview', 'setup']);
  });

  it('draws Overview, Documents and Setup while a job is active', () => {
    const job = { state: 'running', documents: [{ documentId: 'd1' }], report: reportOf() };
    expect(keys(jobSections(job, 4))).toEqual(['overview', 'documents 1', 'setup']);
  });
});
