import { describe, it, expect } from 'vitest';
import { soleProjectLinking, assistantProjectOf } from './vocabProject.js';

const P = (id, ...vocabIds) => ({ id, vocabs: vocabIds.map((v) => ({ id: v })) });

describe('soleProjectLinking', () => {
  it('takes the one project that links the vocabulary', () => {
    expect(soleProjectLinking([P('p1', 'v1'), P('p2', 'v2')], 'v1')).toBe('p1');
    // Among that project's other vocabularies, still one project.
    expect(soleProjectLinking([P('p1', 'v0', 'v1', 'v2')], 'v1')).toBe('p1');
  });

  it('resolves several linking projects to nothing rather than to a guess', () => {
    // A shared lexicon. Picking one would file the conversation under a project
    // the user was never on, so the pane is not offered at all.
    expect(soleProjectLinking([P('p1', 'v1'), P('p2', 'v1')], 'v1')).toBeNull();
  });

  it('answers nothing for no link, no vocabulary, and malformed input', () => {
    expect(soleProjectLinking([P('p1', 'v2')], 'v1')).toBeNull();
    expect(soleProjectLinking([P('p1', 'v1')], null)).toBeNull();
    expect(soleProjectLinking(null, 'v1')).toBeNull();
    expect(soleProjectLinking([{ id: 'p1' }, {}, null], 'v1')).toBeNull();
  });
});

describe('assistantProjectOf', () => {
  const V = { id: 'v1', project: 'home' };
  it("takes the vocabulary's own project when the person can read it", () => {
    // After a move the old home still links it, and a member of both would
    // otherwise lose the pane. A member of the home who also reads a
    // borrower gets one too.
    expect(assistantProjectOf([P('old', 'v1'), P('home', 'v1')], V)).toBe('home');
    expect(assistantProjectOf([P('home', 'v1'), P('b1', 'v1'), P('b2', 'v1')], V)).toBe('home');
  });

  it('else the one readable project that links it, else nothing', () => {
    expect(assistantProjectOf([P('b1', 'v1')], V)).toBe('b1');
    expect(assistantProjectOf([P('b1', 'v1'), P('b2', 'v1')], V)).toBeNull();
    expect(assistantProjectOf([], V)).toBeNull();
    expect(assistantProjectOf([P('home', 'v1')], null)).toBeNull();
  });
});
