import { describe, it, expect } from 'vitest';
import { ROLES } from '@larc-iu/plaid-client';
import {
  leftCount,
  leftGroups,
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
    expect(undoneLine(s)).toBe('12 values, 5 links and 2 lexicon entries');
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
    expect(undoneLine(s, { tokenRows })).toBe('1 value, 1 word and 2 morphemes');
  });

  it('counts tokens as one when the rows do not account for them all', () => {
    const s = summary({ tokens: counts(3, 'deleted') });
    expect(undoneLine(s)).toBe('3 tokens');
    expect(undoneLine(s, { tokenRows: [{ id: 'w1', role: ROLES.WORD }] })).toBe('3 tokens');
    // Rows left past the listed ones: which tokens they are is not known.
    const cut = { ...s, skippedCount: 1500 };
    const rows = ['a', 'b', 'c'].map((id) => ({ id, role: ROLES.WORD }));
    expect(undoneLine(cut, { tokenRows: rows })).toBe('3 tokens');
    expect(undoneLine(s, { tokenRows: rows })).toBe('3 words');
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

  it('takes core’s count for rows past those listed when one reason holds them all', () => {
    const s = { ...summary({}, [row('a', 'changed-since')]), skippedCount: 1500 };
    expect(leftGroups(s)[0].count).toBe(1500);
    expect(leftCount(s)).toBe(1500);
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
        { opType: 'thing/new', count: 1 },
      ],
    });
    expect(notUndoneLines(s)).toEqual([
      'Project settings are not undone.',
      'Fields and their settings are not undone.',
      'Vocabularies and their settings are not undone.',
      'Users and invitations are not undone.',
      'thing/new are not undone.',
    ]);
  });
});

describe('undoneToast', () => {
  it('says what was undone and how many were left', () => {
    expect(undoneToast(summary({ spans: counts(1) }))).toEqual({
      title: 'Undone',
      message: '1 value undone.',
    });
    const left = summary({ spans: counts(3) }, [
      { kind: 'span', id: 'a', reason: 'changed-since' },
      { kind: 'span', id: 'b', reason: 'changed-since' },
    ]);
    expect(undoneToast(left).message).toBe('3 values undone. 2 changes left as they were.');
    expect(undoneToast(summary({}, [{ kind: 'span', id: 'a', reason: 'locked' }])).message).toBe(
      'Nothing undone. 1 change left as it was.',
    );
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
