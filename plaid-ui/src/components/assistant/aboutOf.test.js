import { describe, it, expect } from 'vitest';
import { aboutOf } from './jobs.js';

// Where a conversation began, as the sidebar row reads it back
// (ConversationList's `m.about?.documentName || m.about?.lexiconName`). The
// shell used to split the subject into four props for this and the panel put
// them back together; the subject travels whole now and this is the only place
// the record's field names are written.

describe('aboutOf', () => {
  it('names a document by its kind', () => {
    expect(aboutOf({ kind: 'document', id: 'd1', name: 'Text 1' })).toEqual({
      documentId: 'd1',
      documentName: 'Text 1',
    });
  });

  it('names a vocabulary the same way', () => {
    expect(aboutOf({ kind: 'lexicon', id: 'v1', name: 'Verbs' })).toEqual({
      lexiconId: 'v1',
      lexiconName: 'Verbs',
    });
  });

  it('is null where the reader is about the project at large', () => {
    // A screen with no one thing in front of the reader publishes no kind, and
    // a conversation started there belongs nowhere in particular.
    expect(aboutOf(null)).toBeNull();
    expect(aboutOf({ kind: null, id: null })).toBeNull();
    expect(aboutOf({ kind: 'document' })).toBeNull();
  });

  it('keeps the id when the name has not loaded yet', () => {
    expect(aboutOf({ kind: 'document', id: 'd1' })).toEqual({
      documentId: 'd1',
      documentName: null,
    });
  });
});
