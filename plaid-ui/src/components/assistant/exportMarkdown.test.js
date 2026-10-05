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
});
