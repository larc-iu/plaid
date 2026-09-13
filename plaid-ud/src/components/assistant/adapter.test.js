import { describe, it, expect } from 'vitest';
import { missingFromAdapter } from '@ui/components/assistant/adapterContract.js';
import { parseCitationHref, sentenceHref, UD_ASSISTANT } from './adapter.js';

// UD's half of the shared assistant screen.

describe('UD_ASSISTANT', () => {
  it('answers everything the shared half asks of an adapter', () => {
    expect(missingFromAdapter(UD_ASSISTANT)).toEqual([]);
  });
});

describe('parseCitationHref', () => {
  it('reads back the sentence sentenceHref wrote', () => {
    const href = sentenceHref('', 'p1', { documentId: 'd1', sentenceId: 'sent-7' });
    expect(parseCitationHref(href)).toEqual({ documentId: 'd1', focus: 'sent-7' });
  });

  it('reads a link to a document with no sentence named', () => {
    // A plan card's group heading. The editor refuses it, so the link opens.
    expect(parseCitationHref('#/projects/p1/documents/d1/annotate')).toEqual({
      documentId: 'd1',
      focus: null,
    });
  });

  it('is null for anything that is not one of this app’s document links', () => {
    expect(parseCitationHref('')).toBeNull();
    expect(parseCitationHref('#/projects/p1/documents/d1/export')).toBeNull();
  });
});
