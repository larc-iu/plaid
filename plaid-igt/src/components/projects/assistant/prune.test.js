import { describe, it, expect } from 'vitest';
import { CONVERSATION_BUDGET, DROPPED, conversationBytes, pruneConversation } from './prune.js';

const toolResult = (id, size) => ({ role: 'tool', toolCallId: id, content: 'x'.repeat(size) });

const conv = (results) => ({
  id: 'c1',
  messages: [
    { role: 'user', content: 'what is going on' },
    ...results,
    { role: 'assistant', content: 'here is what I found' },
  ],
  display: [{ kind: 'user', text: 'what is going on' }],
});

describe('pruneConversation', () => {
  it('leaves a conversation inside its budget untouched', () => {
    const c = conv([toolResult('a', 100)]);
    expect(pruneConversation(c)).toBe(c);
  });

  it('drops the oldest tool results first, and only as many as it must', () => {
    const c = conv([toolResult('a', 400), toolResult('b', 400), toolResult('c', 400)]);
    const out = pruneConversation(c, 900);
    expect(out.messages.map((m) => m.content.length)).toEqual([
      'what is going on'.length,
      DROPPED.length,
      DROPPED.length,
      400,
      'here is what I found'.length,
    ]);
    expect(conversationBytes(out)).toBeLessThanOrEqual(900);
    expect(c.messages[0].content).toBe('what is going on'); // the input is not mutated
    expect(c.messages[1].content.length).toBe(400);
  });

  it('keeps the questions, the replies, and the tool-call pairing', () => {
    const c = {
      id: 'c1',
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'a', function: { name: 'search' } }],
        },
        toolResult('a', 5000),
        { role: 'assistant', content: 'answer' },
      ],
      display: [],
    };
    const out = pruneConversation(c, 200);
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(out.messages[1].toolCalls).toEqual(c.messages[1].toolCalls);
    expect(out.messages[2].toolCallId).toBe('a');
    expect(out.messages[3].content).toBe('answer');
  });

  it('does not re-drop what is already dropped', () => {
    const once = pruneConversation(conv([toolResult('a', 5000), toolResult('b', 5000)]), 400);
    const twice = pruneConversation(once, 400);
    expect(twice.messages.filter((m) => m.content === DROPPED)).toHaveLength(2);
  });

  it('budgets under what the server accepts', () => {
    expect(CONVERSATION_BUDGET).toBeLessThan(1000000);
  });
});
