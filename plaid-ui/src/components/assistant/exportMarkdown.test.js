import { describe, expect, it } from 'vitest';
import { conversationToMarkdown } from './exportMarkdown.js';

const md = (display) =>
  conversationToMarkdown({ display }, { title: 'T' }, { origin: '', projectId: 'p1', adapter: {} });

describe('conversationToMarkdown', () => {
  it('writes the steps line only for a turn that called a tool, as the panel shows it', () => {
    const noTool = md([{ kind: 'assistant', text: 'Hi.', stepsSummary: '0 steps', steps: [] }]);
    expect(noTool).not.toContain('0 steps');
    const oneTool = md([
      { kind: 'assistant', text: 'Hi.', stepsSummary: '1 step', steps: [{ name: 'read' }] },
    ]);
    expect(oneTool).toContain('*1 step*');
  });

  // A4-CROSS-3: "What does section 4.2 of this grammar say" no longer said
  // which grammar. The export names the files as the chips on screen do.
  it('names the files attached to a question and the ones a reply fetched', () => {
    const out = md([
      {
        kind: 'user',
        text: 'What does 4.2 say?',
        files: [{ id: 'f1', name: 'tolemi_grammar.pdf' }],
      },
      {
        kind: 'assistant',
        text: 'It says so.',
        files: [
          { id: 'f2', name: 'g.pdf', source: 'https://r.example/a b/g.pdf' },
          { id: 'f3', name: 'notes.txt', source: 'javascript:alert(1)' },
        ],
      },
    ]);
    expect(out).toContain('*Attached: tolemi\\_grammar.pdf*');
    expect(out).toContain('*Fetched: [g.pdf](<https://r.example/a%20b/g.pdf>), notes.txt*');
  });

  it('names a file a reply made apart from what it fetched', () => {
    const out = md([
      {
        kind: 'assistant',
        text: 'Here it is.',
        files: [{ id: 'f4', name: 'words cleaned.csv', made: true }],
      },
    ]);
    expect(out).toContain('*Files: words cleaned.csv*');
    expect(out).not.toContain('Fetched');
  });
});
