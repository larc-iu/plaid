import { describe, it, expect } from 'vitest';
import { APP_ROUTES, parseSentenceHref } from './appRoutes.js';

// Every sentence link in this app is built here, so these strings are the ones
// the search hits, comments, citations, plan changes and the copied sentence
// link all land on.
describe('APP_ROUTES.sentence', () => {
  it('opens the sentence on the Analyze tab, with the caret on a word when it names one', () => {
    expect(APP_ROUTES.sentence('p1', 'd1', 's1')).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=s1',
    );
    expect(APP_ROUTES.sentence('p1', 'd1', 's1', { word: 12 })).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=s1&focusWord=12',
    );
    expect(APP_ROUTES.sentence('p1', 'd1', 's1', { word: 0 })).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=s1&focusWord=0',
    );
    expect(APP_ROUTES.sentence('p1', 'd1', 's1', { word: null })).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=s1',
    );
  });

  it('encodes the sentence id', () => {
    expect(APP_ROUTES.sentence('p1', 'd1', 'a&b c')).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=a%26b%20c',
    );
  });

  it("is the document's Analyze tab when no sentence is named", () => {
    expect(APP_ROUTES.sentence('p1', 'd1', null)).toBe('/projects/p1/documents/d1?tab=analyze');
  });
});

describe('parseSentenceHref', () => {
  it('reads back what the route writes, behind a hash and an origin', () => {
    const href = `https://x.org/igt/#${APP_ROUTES.sentence('p1', 'd1', 'a&b', { word: 7 })}`;
    expect(parseSentenceHref(href)).toEqual({ documentId: 'd1', sentenceId: 'a&b', word: 7 });
    expect(parseSentenceHref(`#${APP_ROUTES.sentence('p1', 'd1', 's1')}`)).toEqual({
      documentId: 'd1',
      sentenceId: 's1',
      word: null,
    });
  });

  it('is null for a link that names no sentence', () => {
    expect(parseSentenceHref(`#${APP_ROUTES.document('p1', 'd1')}`)).toBeNull();
    expect(parseSentenceHref('https://example.org/')).toBeNull();
    expect(parseSentenceHref(undefined)).toBeNull();
  });
});
