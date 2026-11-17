import { describe, it, expect, vi, beforeEach } from 'vitest';

// A turn whose request the server ended under the assistant (its connection
// to the server dropped and did not come back in time). The page's own stream
// ends with "Service disconnected", the assistant records the turn as a lost
// connection (plaid-agent CONNECTION_LOST_LINE), and the page offers Retry. It
// never says "Stopped.", which is only for a Stop the reader pressed.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { all } = await import('../../test/renderComponent.jsx');
const { jobs, serviceCache } = await import('./jobs.js');
const chat = await import('../../test/assistantChat.jsx');
const { KEYS, META, chatClient, mountChat, typeAndSend } = chat;
const notify = await import('../../lib/notify.js');

const LOST = 'The connection to the assistant was lost before it finished. Nothing was changed.';

const QUESTION = {
  messages: [{ role: 'user', content: 'gloss it' }],
  display: [{ kind: 'user', text: 'gloss it' }],
};

const lostItem = {
  kind: 'error',
  text: LOST,
  steps: [{ label: 'Read “Text 1”', kind: 'read' }],
  partial: 'Two of the',
  createdAt: '2026-11-17T16:01:51Z',
};

const button = (m, label) => all(m.container, 'button').find((b) => b.textContent.trim() === label);

const flush = (m, times = 8) => chat.flush(m, times);

beforeEach(() => {
  vi.clearAllMocks();
  jobs.clear();
  serviceCache.clear();
});

describe('a turn recorded as a lost connection', () => {
  it('reads as a turn that did not finish, with Retry, after a reload', async () => {
    const client = chatClient({
      conv: { messages: QUESTION.messages, display: [...QUESTION.display, lostItem] },
    });
    const m = await mountChat(client);
    await flush(m);
    const text = m.container.textContent;
    expect(text).toContain(LOST);
    expect(text).toContain('That turn did not finish.');
    expect(text).not.toContain('Stopped.');
    expect(button(m, 'Retry')).toBeTruthy();
  });

  it('Retry sends the question again', async () => {
    const client = chatClient({
      conv: { messages: QUESTION.messages, display: [...QUESTION.display, lostItem] },
      answer: 'Answered.',
    });
    const m = await mountChat(client);
    await flush(m);
    await m.step(() => button(m, 'Retry').click());
    await flush(m, 12);
    expect(client.assistant.ops.map((o) => o.op)).toContain('retry');
    expect(m.container.textContent).toContain('Answered.');
  });
});

describe('a turn whose request the server ended live', () => {
  it('raises no error, never says Stopped, and shows the record the assistant writes', async () => {
    const client = chatClient({ conv: { messages: [], display: [] }, meta: { ...META, turns: 0 } });
    // The assistant took the message and marked it, then the server ended
    // the request: the page's stream ends with the server's error.
    client.assistant.during = async () => {
      // As the client rejects on the stream's `error` event: no status.
      throw new Error('Service disconnected');
    };
    const m = await mountChat(client);
    await flush(m);
    await typeAndSend(m, 'gloss it');
    await flush(m, 12);
    expect(notify.notifyError).not.toHaveBeenCalled();
    expect(m.container.textContent).not.toContain('Stopped.');
    // The assistant records the turn when it next reports and is refused.
    const conv = client.records.get(KEYS.conv);
    client.records.set(KEYS.conv, { ...conv, display: [...conv.display, lostItem] });
    client.records.set(KEYS.meta, {
      ...client.records.get(KEYS.meta),
      pending: null,
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    await m.step(() => window.dispatchEvent(new Event('focus')));
    await flush(m, 12);
    const text = m.container.textContent;
    expect(text).toContain(LOST);
    expect(text).toContain('That turn did not finish.');
    expect(text).not.toContain('Stopped.');
    expect(button(m, 'Retry')).toBeTruthy();
  });
});
