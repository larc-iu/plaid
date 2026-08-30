import { describe, it, expect } from 'vitest';
import {
  conversationToMarkdown,
  replyToMarkdown,
  citationToMarkdown,
  markdownFilename,
} from './exportMarkdown.js';

const ctx = { origin: 'http://x/', projectId: 'p1', projectName: 'Demo' };
const cite = {
  key: '<cite doc="Text 1" ref="s3.w2"/>',
  documentId: 'd1',
  documentName: 'Text 1',
  sentenceId: 's-3',
  sentence: 3,
  word: 2,
  text: 'Ali-di gam akuna.',
  words: [
    { index: 1, surface: 'Ali-di', seg: 'Ali-di', lines: [{ field: 'Gloss', value: 'Ali-ERG' }] },
    { index: 2, surface: 'gam', seg: null, lines: [{ field: 'Gloss', value: 'fish' }] },
    { index: 3, surface: 'akuna', seg: null, lines: [] },
  ],
  fields: [{ field: 'Translation', value: 'Ali saw a fish.' }],
};

describe('citationToMarkdown', () => {
  it('renders a linked interlinear table with the cited word bold', () => {
    const md = citationToMarkdown(cite, ctx);
    expect(md).toBe(
      [
        '**[Text 1, sentence 3, word 2](http://x/#/projects/p1/documents/d1?tab=analyze&focusSentence=s-3)**',
        '',
        '| | Ali-di | **gam** | akuna |',
        '|---|---|---|---|',
        '| Morphemes | Ali-di |  |  |',
        '| Gloss | Ali-ERG | fish |  |',
        '',
        '*Translation:* Ali saw a fish.',
      ].join('\n'),
    );
  });

  it('bolds the morphemes a citation names inside a word', () => {
    const md = citationToMarkdown(
      {
        ...cite,
        word: undefined,
        focus: [{ word: 1, morpheme: 2 }],
        words: [
          {
            index: 1,
            surface: 'Ali-di',
            seg: 'Ali-di',
            morphs: ['Ali', 'di'],
            joiners: ['-'],
            lines: [{ field: 'Gloss', value: 'Ali-ERG', parts: ['Ali', 'ERG'] }],
          },
          ...cite.words.slice(1),
        ],
      },
      ctx,
    );
    expect(md).toContain('| Morphemes | Ali-**di** |');
    expect(md).toContain('| Gloss | Ali-**ERG** | fish |  |');
  });

  it('bolds every word a citation names', () => {
    const md = citationToMarkdown(
      {
        ...cite,
        word: undefined,
        focus: [
          { word: 1, morpheme: 2 },
          { word: 3, morpheme: null },
        ],
      },
      ctx,
    );
    expect(md).toContain('| | **Ali-di** | gam | **akuna** |');
  });
});

describe('replyToMarkdown', () => {
  it('expands a standalone citation in place and links an inline one, listing its table after', () => {
    const md = replyToMarkdown(
      'Example:\n<cite doc="Text 1" ref="s3.w2"/>\nsee also <cite doc="Nope" ref="s9"/> and {{Nope s9}}.',
      [cite],
      ctx,
    );
    expect(md).toContain('Example:\n**[Text 1, sentence 3, word 2]');
    // Unresolved citations are flattened to what they name, never left as markup.
    expect(md).toContain('see also Nope s9 and Nope s9.');
    expect(md).not.toContain('Cited examples');
    const md2 = replyToMarkdown('Inline <cite doc="Text 1" ref="s3.w2"/> only.', [cite], ctx);
    expect(md2).toMatch(
      /^Inline \[Text 1, sentence 3, word 2\]\(http:\/\/x\/#\/projects\/p1\/documents\/d1\?tab=analyze&focusSentence=s-3\) only\.\n\n\*\*Cited examples\*\*/,
    );
  });
});

describe('conversationToMarkdown', () => {
  it('writes the whole conversation with plans and their outcome', () => {
    const conv = {
      display: [
        { kind: 'user', text: 'Gloss gam as fish' },
        {
          kind: 'assistant',
          text: 'Planned it.',
          plan: { summary: '1 field value', labels: ['Text 1 s1.w2 "gam": Gloss = "fish"'] },
          status: 'applied',
          steps: [{ label: 'read' }, { label: 'plan' }],
        },
        { kind: 'error', text: 'boom' },
      ],
    };
    const md = conversationToMarkdown(
      conv,
      { title: 'Gloss gam', model: 'openai/x', createdAt: '2026-08-30T01:02:03Z' },
      { ...ctx, summarizeSteps: (s) => `${s.length} steps` },
    );
    expect(md).toBe(
      [
        '# Gloss gam',
        '',
        'Project: Demo · Assistant: openai/x · Started: 2026-08-30',
        '',
        '## You',
        '',
        'Gloss gam as fish',
        '',
        '## Assistant',
        '',
        '*2 steps*',
        '',
        'Planned it.',
        '',
        '**Proposed changes:** 1 field value (Approved and applied.)',
        '',
        '1. Text 1 s1.w2 "gam": Gloss = "fish"',
        '',
        '> **Error:** boom',
        '',
      ].join('\n'),
    );
  });

  it('names the file after the title', () => {
    expect(markdownFilename({ title: 'How do relative clauses work in Lezgi?' })).toBe(
      'how-do-relative-clauses-work-in-lezgi.md',
    );
    expect(markdownFilename({})).toBe('conversation.md');
  });
});
