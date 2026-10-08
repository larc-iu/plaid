import { describe, it, expect } from 'vitest';
import { missingFromAdapter } from '@ui/components/assistant/adapterContract.js';
import { IGT_ASSISTANT, parseCitationHref, sentenceHref } from './adapter.js';

// A citation into the open document scrolls the grid instead of opening a
// second tab. That only delivers as much as the link it replaces if the WORD
// survives the round trip: the island lands on the cited word when it is given
// one, and on the sentence alone when it is not.

const CITATION = {
  documentId: 'd1',
  sentenceId: 'sent-7',
  words: [
    { index: 1, begin: 0 },
    { index: 2, begin: 4 },
  ],
  focus: [{ word: 2 }],
};

describe('parseCitationHref', () => {
  it('reads back everything sentenceHref wrote, the cited word included', () => {
    const href = sentenceHref('', 'p1', CITATION);
    expect(parseCitationHref(href)).toEqual({ documentId: 'd1', focus: 'sent-7', begin: 4 });
  });

  it('reads a citation that names no word', () => {
    const href = sentenceHref('', 'p1', { ...CITATION, focus: [] });
    expect(parseCitationHref(href)).toEqual({ documentId: 'd1', focus: 'sent-7', begin: null });
  });

  it('is null for anything that is not a citation link', () => {
    expect(parseCitationHref('')).toBeNull();
    expect(parseCitationHref('#/projects/p1/documents/d1?tab=analyze')).toBeNull();
  });
});

describe('IGT_ASSISTANT', () => {
  it('answers everything the shared half asks of an adapter', () => {
    expect(missingFromAdapter(IGT_ASSISTANT)).toEqual([]);
  });

  it('opens only a project set up for IGT', () => {
    // "Add project" offers only these. Another app's project, or one never
    // set up, was offered and then "could not be opened".
    expect(IGT_ASSISTANT.opensProject({ config: { igt: { initialized: true } } })).toBe(true);
    expect(IGT_ASSISTANT.opensProject({ config: { ud: { initialized: true } } })).toBe(false);
    expect(IGT_ASSISTANT.opensProject({ config: {} })).toBe(false);
    expect(IGT_ASSISTANT.opensProject({})).toBe(false);
  });
});
