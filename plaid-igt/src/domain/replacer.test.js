import { describe, it, expect } from 'vitest';
import { buildReplacer, MATCH_EMPTY } from './replacer.js';

const run = (find, matchType, replacement, values) => {
  const { apply, error } = buildReplacer(find, matchType, replacement);
  return { error, out: values.map((v) => apply(v)) };
};

describe('buildReplacer', () => {
  it('rewrites a literal match, case-insensitively', () => {
    expect(run('ka', 'contains', 'ga', ['kat', 'KAt', 'imbwa']).out).toEqual(['gat', 'gat', null]);
  });

  it('rewrites only a whole value on an exact match', () => {
    expect(run('draft', 'exact', 'published', ['draft', 'drafted']).out).toEqual([
      'published',
      null,
    ]);
  });

  it('rewrites through a regex, with groups', () => {
    expect(run('([aeiou])h', 'regex', '$1', ['ah', 'oho', 'kt']).out).toEqual(['a', 'oo', null]);
  });

  it('reports a bad regex and then matches nothing', () => {
    const { error, out } = run('([', 'regex', 'x', ['anything']);
    expect(error).toBeTruthy();
    expect(out).toEqual([null]);
  });

  it('says nothing changed when the match rewrites to itself', () => {
    expect(run('kat', 'exact', 'kat', ['kat']).out).toEqual([null]);
  });

  it('matches nothing without something to find', () => {
    expect(run('', 'contains', 'published', ['kat', '']).out).toEqual([null, null]);
  });

  // The three search kinds all skip an empty value, which is why filling a
  // blank needs its own kind. This is the behaviour MATCH_EMPTY exists for.
  it('skips an empty value in every search kind', () => {
    expect(run('a', 'contains', 'b', ['', null, undefined]).out).toEqual([null, null, null]);
    expect(run('.*', 'regex', 'published', ['', null]).out).toEqual([null, null]);
  });
});

describe('buildReplacer, filling a blank', () => {
  it('fills only the values that are not there', () => {
    expect(run('', MATCH_EMPTY, 'published', ['', null, undefined, 'draft']).out).toEqual([
      'published',
      'published',
      'published',
      null,
    ]);
  });

  it('ignores whatever is in the find box', () => {
    expect(run('anything at all', MATCH_EMPTY, 'published', ['', 'draft']).out).toEqual([
      'published',
      null,
    ]);
  });

  it('changes nothing when there is no value to set', () => {
    expect(run('', MATCH_EMPTY, '', ['', 'draft']).out).toEqual([null, null]);
    expect(run('', MATCH_EMPTY, undefined, ['']).out).toEqual([null]);
  });

  it('never reports an error', () => {
    expect(run('([', MATCH_EMPTY, 'published', ['']).error).toBeNull();
  });
});
