import { describe, it, expect } from 'vitest';
import { missingFromAdapter } from '@ui/components/assistant/adapterContract.js';
import { parseCitationHref, sentenceHref, UMR_ASSISTANT } from './adapter.js';

// UMR's half of the shared assistant screen.

describe('UMR_ASSISTANT', () => {
  it('answers everything the shared half asks of an adapter', () => {
    expect(missingFromAdapter(UMR_ASSISTANT)).toEqual([]);
  });
});

describe('citationTitle', () => {
  const title = UMR_ASSISTANT.citationTitle;

  it('names the sentence, and the nodes the citation singled out', () => {
    expect(title({ documentName: 'Story', sentence: 3, focus: [] })).toBe('Story, sentence 3');
    expect(title({ documentName: 'Story', sentence: 3, focus: ['s3e'] })).toBe(
      'Story, sentence 3, node s3e',
    );
    expect(title({ documentName: 'Story', sentence: 3, focus: ['s3e', 's3p'] })).toBe(
      'Story, sentence 3, nodes s3e, s3p',
    );
  });
});

describe('CITE_RE', () => {
  const matches = (text) => text.match(new RegExp(UMR_ASSISTANT.CITE_RE.source, 'g')) || [];

  it('finds a cite tag and a bare node reference', () => {
    expect(matches('see <cite doc="Story" ref="s3"/> and s4.s4p')).toEqual([
      '<cite doc="Story" ref="s3"/>',
      's4.s4p',
    ]);
  });

  it('leaves a bare sentence number alone', () => {
    // Otherwise every "s3" in a sentence of prose becomes a link.
    expect(matches('the s3 case')).toEqual([]);
  });
});

describe('parseCitationHref', () => {
  it('reads back the document sentenceHref wrote', () => {
    const href = sentenceHref('', 'p1', { documentId: 'd1', sentence: 3 });
    expect(href).toBe('#/projects/p1/documents/d1/annotate?sent=3');
    expect(parseCitationHref(href)).toEqual({
      documentId: 'd1',
      focus: { sentence: '3', var: null },
    });
    // With a cited node, the node too.
    const withNode = sentenceHref('', 'p1', { documentId: 'd1', sentence: 3, focus: ['s3e'] });
    expect(parseCitationHref(withNode)?.focus).toEqual({ sentence: '3', var: 's3e' });
    // A link to the document alone names no sentence.
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

describe('changePlace', () => {
  it('names the node, with its reference beside it', () => {
    expect(
      UMR_ASSISTANT.changePlace('p1', {
        kind: 'token',
        documentId: 'd1',
        documentName: 'Story',
        sentence: 3,
        ref: 's3.s3e',
        node: 's3e',
      }),
    ).toEqual({
      href: '#/projects/p1/documents/d1/annotate?sent=3&var=s3e',
      title: 'Story, sentence 3, node s3e',
      name: 's3e',
      detail: 's3.s3e',
    });
  });

  it('names the document for a change that is about the whole of one', () => {
    expect(
      UMR_ASSISTANT.changePlace('p1', {
        kind: 'document',
        documentId: 'd1',
        documentName: 'Story',
      }),
    ).toEqual({
      href: '#/projects/p1/documents/d1/annotate',
      title: 'Story',
      name: 'Story',
      detail: null,
    });
  });
});

describe('citationToMarkdown', () => {
  it('writes the words, the gloss lines that line up with them, and the graph', () => {
    const md = UMR_ASSISTANT.citationToMarkdown(
      {
        documentName: 'Story',
        documentId: 'd1',
        sentence: 1,
        focus: ['s1d'],
        text: 'The dog barked .',
        words: [
          { index: 1, text: 'The' },
          { index: 2, text: 'dog' },
        ],
        lines: [
          { header: 'Word Gloss', items: ['the', 'dog'] },
          { header: 'Sentence Gloss', items: ['a', 'dog', 'barked', 'once'] },
        ],
        penman: '(s1b / bark-01)',
      },
      { origin: '', projectId: 'p1' },
    );
    expect(md).toContain('| The | dog |');
    expect(md).toContain('| the | dog |');
    // A line that does not line up with the words is not forced into columns.
    expect(md).not.toContain('| a | dog | barked | once |');
    expect(md).toContain('```\n(s1b / bark-01)\n```');
    expect(md).toContain('Nodes cited: s1d');
  });
});
