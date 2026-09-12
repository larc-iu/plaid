import { describe, it, expect } from 'vitest';
import { soleProjectLinking } from './vocabProject.js';

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
