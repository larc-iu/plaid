import { describe, it, expect } from 'vitest';
import { APP_ROUTES, parseSentenceHref } from './appRoutes.js';

// Every sentence link in this app is built here: search, validation, the text
// editor's hand-over, citations and plan changes.
describe('APP_ROUTES.sentence', () => {
  it('opens the sentence on Annotate by its token id, encoded', () => {
    expect(APP_ROUTES.sentence('p1', 'd1', 's1')).toBe(
      '/projects/p1/documents/d1/annotate?sent=s1',
    );
    expect(APP_ROUTES.sentence('p1', 'd1', 'a&b c')).toBe(
      '/projects/p1/documents/d1/annotate?sent=a%26b%20c',
    );
  });

  it('is the document itself when no sentence is named', () => {
    expect(APP_ROUTES.sentence('p1', 'd1', null)).toBe(APP_ROUTES.document('p1', 'd1'));
  });
});

describe('parseSentenceHref', () => {
  it('reads back what the routes write, behind a hash and an origin', () => {
    expect(
      parseSentenceHref(`https://x.org/ud/#${APP_ROUTES.sentence('p1', 'd1', 'a&b')}`),
    ).toEqual({ documentId: 'd1', sentenceId: 'a&b' });
    expect(parseSentenceHref(`#${APP_ROUTES.document('p1', 'd1')}`)).toEqual({
      documentId: 'd1',
      sentenceId: null,
    });
  });

  it('is null for a link into nothing this app shows', () => {
    expect(parseSentenceHref('#/projects/p1/assistant')).toBeNull();
    expect(parseSentenceHref(undefined)).toBeNull();
  });
});
