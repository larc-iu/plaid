import { describe, it, expect } from 'vitest';
import { ROLES } from '@larc-iu/plaid-client';
import {
  jobUndoError,
  leftCounts,
  leftGroups,
  leftLine,
  notUndoneLines,
  undoError,
  undoneLine,
  undoneToast,
} from './undoSummary.js';

// Core's answer to an undo (audit.undo), as the JS client recases it.
const counts = (n, how = 'updated') => ({ inserted: 0, updated: 0, deleted: 0, [how]: n });
const summary = (undone = {}, skipped = [], extra = {}) => ({
  entry: 'e1',
  dryRun: true,
  undone,
  total: Object.values(undone).reduce((n, c) => n + c.inserted + c.updated + c.deleted, 0),
  rows: 0,
  skipped,
  skippedCount: skipped.length,
  notUndone: [],
  ...extra,
});

const httpError = (status, responseData = {}) =>
  Object.assign(new Error(`HTTP ${status} x at http://x/y`), { status, responseData });

describe('undoneLine', () => {
  it('names each kind in the app’s words, with counts, joined as a list', () => {
    const s = summary({
      spans: counts(12),
      vocabItems: counts(2, 'inserted'),
      vocabLinks: counts(5),
      texts: counts(0),
    });
    expect(undoneLine(s)).toBe(
      '12 values put back as they were, 5 links put back as they were and 2 lexicon entries brought back',
    );
  });

  it('says whether an entry or a document comes back, goes, or is set back', () => {
    expect(
      undoneLine(
        summary({ vocabItems: { inserted: 1, deleted: 2, updated: 3 }, vocabLinks: counts(1) }),
      ),
    ).toBe(
      '1 link put back as it was, 1 lexicon entry brought back, 2 lexicon entries removed and 3 lexicon entries put back as they were',
    );
    // A document's own row is its name and details, not the document.
    expect(undoneLine(summary({ documents: counts(1) }))).toBe(
      'the document’s name or details put back as they were',
    );
    expect(undoneLine(summary({ documents: counts(1, 'inserted') }))).toBe(
      '1 document brought back',
    );
    expect(undoneLine(summary({ documents: counts(1, 'deleted') }))).toBe('1 document removed');
  });

  it('says nothing for an undo of nothing', () => {
    expect(undoneLine(summary({ spans: counts(0) }))).toBe('');
    expect(undoneLine(null)).toBe('');
  });

  it('names tokens by role from the entry’s rows, those left aside', () => {
    const s = summary({ tokens: counts(3, 'deleted'), spans: counts(1) }, [
      {
        kind: 'token',
        id: 'm4',
        document: 'd1',
        reason: 'built-on',
        by: { kind: 'span', id: 's' },
      },
    ]);
    const tokenRows = [
      { id: 'w1', role: ROLES.WORD },
      { id: 'm1', role: ROLES.MORPHEME },
      { id: 'm2', role: ROLES.MORPHEME },
      { id: 'm4', role: ROLES.MORPHEME },
    ];
    expect(undoneLine(s, { tokenRows })).toBe(
      '1 value put back as it was, 1 word removed and 2 morphemes removed',
    );
  });

  it('counts tokens as one when the rows do not account for them all', () => {
    const s = summary({ tokens: counts(3, 'deleted') });
    expect(undoneLine(s)).toBe('3 tokens removed');
    expect(undoneLine(s, { tokenRows: [{ id: 'w1', role: ROLES.WORD }] })).toBe('3 tokens removed');
    // Rows left past the listed ones: which tokens they are is not known.
    const cut = { ...s, skippedCount: 1500 };
    const rows = ['a', 'b', 'c'].map((id) => ({ id, role: ROLES.WORD }));
    expect(undoneLine(cut, { tokenRows: rows })).toBe('3 tokens removed');
    expect(undoneLine(s, { tokenRows: rows })).toBe('3 words removed');
  });

  // REV-RPF3B-2: every part says what happens to it, so no bare count reads
  // under the next part's verb. REV-RPF3B-7: one verb for one act.
  it('says what happens to the tokens, the text and the documents too', () => {
    const morphemes = (n, p = 'm') =>
      Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, role: ROLES.MORPHEME }));
    // A person re-segments a word: two glossed morphemes made one linked one.
    expect(
      undoneLine(
        summary({
          spans: { inserted: 2, updated: 0, deleted: 1 },
          tokens: { inserted: 2, updated: 0, deleted: 1 },
          vocabLinks: counts(1, 'deleted'),
        }),
        { tokenRows: [...morphemes(2), { id: 'n0', role: ROLES.MORPHEME }] },
      ),
    ).toBe(
      '2 values brought back, 1 value removed, 2 morphemes brought back, 1 morpheme removed and 1 link removed',
    );
    // A job segments a word and re-points an existing link.
    expect(
      undoneLine(
        summary({
          spans: counts(2, 'deleted'),
          tokens: counts(2, 'deleted'),
          vocabLinks: counts(1),
        }),
        { tokenRows: morphemes(2) },
      ),
    ).toBe('2 values removed, 2 morphemes removed and 1 link put back as it was');
    // Words and morphemes, some brought back and some removed: as tokens.
    expect(
      undoneLine(summary({ tokens: { inserted: 1, updated: 0, deleted: 2 } }), {
        tokenRows: [{ id: 'w1', role: ROLES.WORD }, ...morphemes(2)],
      }),
    ).toBe('1 token brought back and 2 tokens removed');
    // A job that edited the text.
    expect(
      undoneLine(summary({ spans: counts(1, 'deleted'), tokens: counts(3), texts: counts(1) }), {
        tokens: 'with-text',
      }),
    ).toBe('1 value removed and the text with its words and sentences put back as it was');
    // S7-1, REV-SJ3-7: with no text undone, its tokens may be sentences, words
    // or morphemes (a job that edits the text may segment too): tokens.
    expect(undoneLine(summary({ tokens: counts(2) }), { tokens: 'with-text' })).toBe(
      '2 tokens put back as they were',
    );
    expect(leftLine([{ kind: 'token', id: 't1' }], { tokens: 'with-text' })).toBe('1 token');
    // An import undone.
    expect(
      undoneLine(
        summary({
          tokens: counts(9880, 'deleted'),
          texts: counts(1, 'deleted'),
          documents: counts(1, 'deleted'),
        }),
      ),
    ).toBe('9,880 tokens removed, 1 text removed and 1 document removed');
  });
});

describe('leftGroups', () => {
  const row = (id, reason, extra = {}) => ({ kind: 'span', id, document: 'd1', reason, ...extra });

  it('groups rows by reason in a fixed order, each in plain words', () => {
    const s = summary({}, [
      row('a', 'value-not-allowed'),
      row('b', 'changed-since'),
      row('c', 'built-on', { by: { kind: 'span', id: 'x' } }),
      row('d', 'changed-since'),
      row('e', 'needs', { needs: { kind: 'token', id: 't' } }),
      row('f', 'text-changed-since'),
      row('m', 'place-taken'),
      row('g', 'not-permitted'),
      row('h', 'locked'),
      row('i', 'name-taken'),
      row('j', 'does-not-fit'),
      row('k', 'changed-between'),
      row('l', 'not-undone'),
    ]);
    expect(leftGroups(s).map((g) => [g.label, g.count])).toEqual([
      ['Changed again later', 2],
      ['Changed by someone else during the entry', 1],
      ['Something was added to it since', 1],
      ['Needs something not brought back', 1],
      ['Text changed since', 1],
      ['Its place is taken', 1],
      ['Not permitted', 1],
      ['Document locked by someone else', 1],
      ['Name taken by another document', 1],
      ['Would not fit the document', 1],
      ['Value no longer allowed', 1],
      ['Vocabulary name and settings', 1],
    ]);
  });

  it('shows a reason it does not know by its code, last', () => {
    const s = summary({}, [row('a', 'brand-new-reason'), row('b', 'changed-since')]);
    expect(leftGroups(s).map((g) => g.label)).toEqual(['Changed again later', 'brand-new-reason']);
  });

  it('counts each group’s rows per place, the unplaced as Elsewhere', () => {
    const s = summary({}, [
      row('a', 'changed-since'),
      row('b', 'changed-since'),
      row('c', 'changed-since'),
      row('d', 'changed-since'),
    ]);
    const place = (r) =>
      r.id === 'd' ? null : { key: r.id === 'c' ? 's2' : 's1', label: 'S', to: '/x' };
    expect(leftGroups(s, place)[0].places).toEqual([
      { key: 's1', label: 'S', to: '/x', count: 2 },
      { key: 's2', label: 'S', to: '/x', count: 1 },
      { key: null, label: 'Elsewhere', to: null, count: 1 },
    ]);
  });

  it('counts only the listed rows in each group, and says how many are not listed', () => {
    const listed = [
      ...Array.from({ length: 600 }, (_, i) => row(`c${i}`, 'changed-since')),
      ...Array.from({ length: 400 }, (_, i) => row(`b${i}`, 'built-on')),
    ];
    const s = { ...summary({}, listed), skippedCount: 2500 };
    expect(leftGroups(s).map((g) => g.count)).toEqual([600, 400]);
    expect(leftCounts(s)).toEqual({ total: 2500, listed: 1000, unlisted: 1500 });
    // One reason too: its count is the rows listed, never core's whole.
    const one = { ...summary({}, [row('a', 'changed-since')]), skippedCount: 1500 };
    expect(leftGroups(one)[0].count).toBe(1);
    expect(leftCounts(one).unlisted).toBe(1499);
    expect(leftCounts(summary({}, [row('a', 'locked')]))).toEqual({
      total: 1,
      listed: 1,
      unlisted: 0,
    });
  });
});

describe('notUndoneLines', () => {
  it('names what is never undone, once each, an unknown type by its code', () => {
    const s = summary({}, [], {
      notUndone: [
        { opType: 'project/update', count: 2 },
        { opType: 'project/add-vocab', count: 1 },
        { opType: 'span-layer/update', count: 1 },
        { opType: 'vocab/update', count: 1 },
        { opType: 'user/update', count: 1 },
        { opType: 'media/upload', count: 1 },
        { opType: 'thing/new', count: 1 },
      ],
    });
    expect(notUndoneLines(s)).toEqual([
      'Project settings are not undone.',
      'Fields and their settings are not undone.',
      'Vocabularies and their settings are not undone.',
      'Users and invitations are not undone.',
      'Recordings are not undone.',
      'Changes of type thing/new are not undone.',
    ]);
  });
});

// S9-3: core counts the rows an undo leaves where the caller cannot read,
// never naming them.
describe('rows left where the caller cannot read', () => {
  it('are said in the dialog and in the result, by count only', () => {
    const s = summary({ vocabLinks: counts(1) }, [], { skippedUnreadable: 2 });
    expect(notUndoneLines(s)).toEqual([
      '2 changes in documents or lexicons you cannot open are not undone.',
    ]);
    expect(notUndoneLines({ ...s, skippedUnreadable: 1 })).toEqual([
      '1 change in documents or lexicons you cannot open is not undone.',
    ]);
    expect(notUndoneLines({ ...s, skippedUnreadable: 0 })).toEqual([]);
    expect(undoneToast(s).message).toBe(
      '1 link put back as it was. 2 changes in documents or lexicons you cannot open are not undone.',
    );
  });
});

describe('undoneToast', () => {
  it('says what was undone and how many were left', () => {
    expect(undoneToast(summary({ spans: counts(1) }))).toEqual({
      title: 'Undone',
      message: '1 value put back as it was.',
      undid: true,
    });
    const left = summary({ spans: counts(3) }, [
      { kind: 'span', id: 'a', reason: 'changed-since' },
      { kind: 'span', id: 'b', reason: 'changed-since' },
    ]);
    // What was left is counted in the nouns of what was undone (RPF-INT 5).
    expect(undoneToast(left).message).toBe('3 values put back as they were. 2 values not undone.');
    // Core's count of what was left, past the rows it lists, whose kinds are
    // not known.
    expect(undoneToast({ ...left, skippedCount: 1200 }).message).toBe(
      '3 values put back as they were. 2 values and 1,198 more not undone.',
    );
    const mixed = summary({ spans: counts(1) }, [
      { kind: 'span', id: 'a', reason: 'changed-since' },
      { kind: 'vocab-link', id: 'b', reason: 'changed-since' },
      { kind: 'token', id: 'c', reason: 'built-on' },
      { kind: 'text', id: 'd', reason: 'text-changed-since' },
    ]);
    expect(undoneToast(mixed).message).toBe(
      '1 value put back as it was. 1 value, 1 token, 1 link and 1 text not undone.',
    );
    // Tokens named as the line of what is undone names them.
    expect(undoneToast(mixed, { tokens: 'morphemes' }).message).toBe(
      '1 value put back as it was. 1 value, 1 morpheme, 1 link and 1 text not undone.',
    );
    expect(
      undoneToast(mixed, {
        tokenRows: [
          { id: 'c', role: ROLES.WORD },
          { id: 'z', role: ROLES.WORD },
        ],
      }).message,
    ).toBe('1 value put back as it was. 1 value, 1 word, 1 link and 1 text not undone.');
  });

  it('is not titled Undone when the call undid nothing', () => {
    expect(undoneToast(summary({}, [{ kind: 'span', id: 'a', reason: 'locked' }]))).toEqual({
      title: 'Nothing undone',
      message: '1 value not undone.',
      undid: false,
    });
  });
});

describe('undoError', () => {
  it('gives each refusal its own sentence', () => {
    expect(undoError(httpError(413))).toBe(
      'Too many changes to undo. An undo takes at most 20,000.',
    );
    expect(undoError(httpError(422))).toBe('A project’s deletion cannot be undone.');
    expect(undoError(httpError(403))).toBe('Only a maintainer can undo this entry.');
    expect(undoError(httpError(403, { unresolved: true }))).toBe(
      'This entry does not exist or cannot be opened.',
    );
    expect(undoError(httpError(404))).toBe('This entry does not exist or cannot be opened.');
    expect(undoError(httpError(500), 'Failed.')).not.toMatch(/http:/);
  });
});

describe('jobUndoError', () => {
  it('says how many changes a job too large made, and where it is undone instead', () => {
    const big = Object.assign(httpError(413), {
      responseData: { error: 'This entry changed 25550 rows. An undo takes at most 20000.' },
    });
    expect(jobUndoError(big)).toBe(
      'This job made 25,550 changes. An undo takes at most 20,000, so this job is undone document by document, from each document’s Changes link on this page.',
    );
    expect(jobUndoError(httpError(413))).toMatch(/^This job made more than 20,000 changes\. /);
    expect(jobUndoError(httpError(409))).toBe(
      'This job has not ended. A job is undone once it has stopped.',
    );
    expect(jobUndoError(httpError(403))).toBe('Only a maintainer can undo this job.');
    expect(jobUndoError(httpError(403, { unresolved: true }))).toBe(
      'This job does not exist or cannot be opened.',
    );
  });
});
