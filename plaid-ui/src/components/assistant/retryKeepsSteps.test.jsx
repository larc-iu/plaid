import { describe, it, expect, vi, beforeEach } from 'vitest';

// Retry after a turn that failed carries on from the steps it had done (the
// owner's ruling 2026-11-18): the assistant keeps the failed turn's calls in
// the model transcript and asks the question again after them
// (`rewind_for_retry` in plaid-agent, mirrored by the fake). On the page the
// failed turn keeps its trace, and the retried turn's answer follows it.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { all } = await import('../../test/renderComponent.jsx');
const { jobs, serviceCache } = await import('./jobs.js');
const chat = await import('../../test/assistantChat.jsx');
const { KEYS, chatClient, mountChat } = chat;

const LINE =
  'The model service did not answer. Nothing was changed. Retry to continue from the steps already done.';
const NOTE =
  '(note) Your turn ended here without a reply: the model service did not answer. Nothing it staged, drafted or saved was kept.';

const failed = {
  messages: [
    { role: 'user', content: 'gloss it' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'k1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      failedTurn: true,
    },
    { role: 'tool', toolCallId: 'k1', content: '3 words', failedTurn: true },
    { role: 'user', content: NOTE, failedTurn: true },
  ],
  display: [
    { kind: 'user', text: 'gloss it' },
    {
      kind: 'error',
      text: LINE,
      steps: [{ label: 'Read “Text 1”', kind: 'read' }],
      stepsSummary: 'Read 1 document',
      createdAt: '2026-11-18T09:00:00Z',
    },
  ],
};

const button = (m, label) => all(m.container, 'button').find((b) => b.textContent.trim() === label);

beforeEach(() => {
  vi.clearAllMocks();
  jobs.clear();
  serviceCache.clear();
});

describe('Retry after a failed turn', () => {
  it('says Retry continues from the steps already done', async () => {
    const m = await mountChat(chatClient({ conv: failed }));
    await chat.flush(m, 8);
    expect(m.container.textContent).toContain(LINE);
    expect(button(m, 'Retry')).toBeTruthy();
  });

  it('keeps the failed turn and its trace, and the answer follows', async () => {
    const client = chatClient({ conv: failed, answer: 'Three words.' });
    const m = await mountChat(client);
    await chat.flush(m, 8);
    await m.step(() => button(m, 'Retry').click());
    await chat.flush(m, 12);
    expect(client.assistant.ops.map((o) => o.op)).toContain('retry');
    const text = m.container.textContent;
    expect(text).toContain(LINE);
    expect(text).toContain('Read 1 document');
    expect(text).toContain('Three words.');
    expect(text.indexOf('Read 1 document')).toBeLessThan(text.indexOf('Three words.'));
    // The record the assistant wrote: the kept steps stay, the question is
    // asked again after them.
    const conv = client.records.get(KEYS.conv);
    expect(conv.messages.map((x) => x.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'user',
      'assistant',
    ]);
    expect(conv.display.map((d) => d.kind)).toEqual(['user', 'error', 'user', 'assistant']);
  });
});
