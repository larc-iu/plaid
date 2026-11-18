import { describe, it, expect, vi, beforeEach } from 'vitest';

// A conversation opened by its link (a job's "Open conversation", a shared
// link, the sidebar) is read before it is shown. A message sent in that time
// went into the new conversation on screen, with `create`, and the address
// moved to it, so the question lost its thread (FLK1-1). The composer waits
// for the record instead.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { MemoryRouter } = await import('react-router-dom');
const { renderComponent } = await import('../../test/renderComponent.jsx');
const { AssistantChat } = await import('./AssistantChat.jsx');
const { jobs, serviceCache } = await import('./jobs.js');
const chat = await import('../../test/assistantChat.jsx');
const { ADAPTER, KEYS, chatClient, mountChat, typeAndSend } = chat;

const CONV = {
  messages: [
    { role: 'user', content: 'gloss it' },
    { role: 'assistant', content: 'Done.' },
  ],
  display: [
    { kind: 'user', text: 'gloss it' },
    { kind: 'assistant', text: 'Done.' },
  ],
};

const sends = (client) =>
  client.messages.requestService.mock.calls.map((c) => c[2]).filter((d) => d.op === 'send');

beforeEach(() => {
  vi.clearAllMocks();
  jobs.clear();
  serviceCache.clear();
});

describe('a message typed while a conversation is being opened', () => {
  it('is not sent into a new conversation, and goes into the opened one once it is there', async () => {
    const client = chatClient({ conv: CONV, answer: 'Answered.' });
    // The record of the conversation is held, as a slow network holds it.
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const get = client.userData.get;
    client.userData.get = vi.fn(async (userId, key) => {
      if (key === KEYS.conv) await held;
      return get(userId, key);
    });
    const m = await mountChat(client, { conversationId: 'c1' });
    await chat.flush(m, 6);
    const box = m.container.querySelector('textarea');
    expect(box.readOnly).toBe(true);
    await typeAndSend(m, 'FOLLOW-UP');
    await chat.flush(m, 6);
    expect(sends(client)).toEqual([]);

    release();
    await chat.flush(m, 10);
    expect(m.container.querySelector('textarea').readOnly).toBe(false);
    await typeAndSend(m, 'FOLLOW-UP');
    await chat.flush(m, 10);
    const sent = sends(client);
    expect(sent).toHaveLength(1);
    expect(sent[0].conversationId).toBe('c1');
    expect(sent[0].create).toBeFalsy();
    await m.unmount();
  });

  it('can be typed in again once the address names no conversation, whatever the read is doing', async () => {
    const client = chatClient({ conv: CONV, answer: 'Answered.' });
    // The record never arrives: only leaving it (Back, "+") ends the wait.
    client.userData.get = vi.fn((userId, key) =>
      key === KEYS.conv
        ? new Promise(() => {})
        : Promise.resolve({ value: client.records.get(key) }),
    );
    const chatAt = (conversationId) => (
      <MemoryRouter initialEntries={['/projects/p1']}>
        <AssistantChat
          projectId="p1"
          projectName="Lamkang A"
          client={client}
          userId="u1"
          canWrite
          adapter={ADAPTER}
          conversationId={conversationId}
        />
      </MemoryRouter>
    );
    const m = await renderComponent(chatAt('c1'));
    await chat.flush(m, 6);
    expect(m.container.querySelector('textarea').readOnly).toBe(true);
    await m.rerender(chatAt(null));
    await chat.flush(m, 6);
    expect(m.container.querySelector('textarea').readOnly).toBe(false);
    await m.unmount();
  });
});
