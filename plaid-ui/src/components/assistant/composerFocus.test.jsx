import { describe, it, expect, vi, beforeEach } from 'vitest';

// H13-1: an answer landing never takes the keyboard from where the reader is
// typing. The composer gets focus back when a turn settles only when focus
// was in the panel, or nowhere.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { jobs, serviceCache } = await import('./jobs.js');
const chat = await import('../../test/assistantChat.jsx');
const { META, chatClient, mountChat, typeAndSend } = chat;

const flush = (m, times = 8) => chat.flush(m, times);

beforeEach(() => {
  jobs.clear();
  serviceCache.clear();
});

const held = () => {
  const client = chatClient({
    conv: { messages: [], display: [] },
    meta: { ...META, turns: 0 },
    answer: 'Answer landed.',
  });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  client.assistant.during = () => gate;
  return { client, release: () => release() };
};

describe('focus when an answer lands', () => {
  it('stays in a field outside the panel the reader moved to', async () => {
    const { client, release } = held();
    const cell = document.createElement('input');
    document.body.appendChild(cell);
    try {
      const m = await mountChat(client);
      await flush(m);
      await typeAndSend(m, 'What does this text say?');
      await flush(m);
      cell.focus();
      await m.step(() => release());
      await flush(m, 12);
      expect(m.container.textContent).toContain('Answer landed.');
      expect(document.activeElement).toBe(cell);
    } finally {
      cell.remove();
    }
  });

  it('comes back to the composer when it was there', async () => {
    const { client, release } = held();
    const m = await mountChat(client);
    await flush(m);
    await typeAndSend(m, 'What does this text say?');
    await flush(m);
    m.container.querySelector('textarea').focus();
    await m.step(() => release());
    await flush(m, 12);
    expect(m.container.textContent).toContain('Answer landed.');
    expect(document.activeElement).toBe(m.container.querySelector('textarea'));
  });
});

describe('focus when a plan is applied', () => {
  const planned = () =>
    chatClient({
      conv: {
        messages: [
          { role: 'user', content: 'gloss it' },
          { role: 'assistant', content: 'A plan.' },
        ],
        display: [
          { kind: 'user', text: 'gloss it' },
          {
            kind: 'assistant',
            text: 'A plan.',
            plan: { id: 'plan-1', summary: '1 change', labels: ['Set a gloss'] },
            status: null,
          },
        ],
      },
    });
  const approve = (m) =>
    [...m.container.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Approve as unverified',
    );

  it('stays in a field outside the panel the reader moved to', async () => {
    const client = planned();
    const cell = document.createElement('input');
    document.body.appendChild(cell);
    try {
      const m = await mountChat(client);
      await flush(m);
      await m.step(() => {
        approve(m).click();
        cell.focus();
      });
      await flush(m, 12);
      expect(client.assistant.ops.map((o) => o.op)).toContain('approve');
      expect(document.activeElement).toBe(cell);
    } finally {
      cell.remove();
    }
  });

  it('stays on the page when nothing had focus', async () => {
    const client = planned();
    const m = await mountChat(client);
    await flush(m);
    await m.step(() => {
      approve(m).click();
      document.activeElement?.blur();
    });
    await flush(m, 12);
    expect(client.assistant.ops.map((o) => o.op)).toContain('approve');
    expect(document.activeElement).toBe(document.body);
  });
});

describe('focus when a message is sent with the button', () => {
  it('goes to the composer', async () => {
    const client = chatClient({
      conv: { messages: [], display: [] },
      meta: { ...META, turns: 0 },
      answer: 'Answer landed.',
    });
    const m = await mountChat(client);
    await flush(m);
    const box = m.container.querySelector('textarea');
    await m.step(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(
        box,
        'Hello',
      );
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const sendButton = [...m.container.querySelectorAll('button')].find((b) => b.title === 'Send');
    await m.step(() => {
      sendButton.focus();
      sendButton.click();
    });
    await flush(m, 12);
    expect(m.container.textContent).toContain('Answer landed.');
    expect(document.activeElement).toBe(box);
  });
});
