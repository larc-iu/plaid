import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';

// A screen asks for a new conversation about itself ("Discuss with the
// assistant" on a job's page, subject.js `useStartConversation`). The docked
// panel resumes the project's newest thread when it comes up, and its read of
// the list answers after the request: the new conversation must stand.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { renderComponent } = await import('../../test/renderComponent.jsx');
const { AssistantChat } = await import('./AssistantChat.jsx');
const { jobs, lastOpen, serviceCache } = await import('./jobs.js');
const chat = await import('../../test/assistantChat.jsx');
const { ADAPTER, chatClient } = chat;

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

// The panel's own state: which conversation is open, and the request.
const Panel = ({ client, fresh, onFreshTaken, opened }) => {
  const [convId, setConvId] = useState(null);
  opened.push(convId);
  return (
    <AssistantChat
      projectId="p1"
      projectName="Lamkang A"
      client={client}
      userId="u1"
      canWrite
      adapter={ADAPTER}
      conversationId={convId}
      onConversationId={(id) => setConvId(id)}
      resumeNewest
      fresh={fresh}
      onFreshTaken={onFreshTaken}
    />
  );
};

const mount = (client, props) =>
  renderComponent(
    <MemoryRouter initialEntries={['/projects/p1/jobs/j1']}>
      <Panel client={client} {...props} />
    </MemoryRouter>,
  );

const thread = (m) => m.container.querySelector('.overflow-y-auto')?.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  jobs.clear();
  lastOpen.clear();
  serviceCache.clear();
});

describe('a new conversation a screen asked for', () => {
  it('is what the panel shows when it opens for it, not the newest thread', async () => {
    const client = chatClient({ conv: CONV });
    const taken = vi.fn();
    const opened = [];
    const m = await mount(client, { fresh: 1, onFreshTaken: taken, opened });
    await chat.flush(m, 10);
    expect(taken).toHaveBeenCalledTimes(1);
    expect(opened.every((id) => id === null)).toBe(true);
    expect(thread(m)).not.toContain('gloss it');
    await m.unmount();
  });

  it('replaces the thread the panel was showing', async () => {
    const client = chatClient({ conv: CONV });
    const taken = vi.fn();
    const opened = [];
    const m = await mount(client, { fresh: null, onFreshTaken: taken, opened });
    await chat.flush(m, 10);
    expect(opened.at(-1)).toBe('c1');
    expect(thread(m)).toContain('gloss it');
    await m.rerender(
      <MemoryRouter initialEntries={['/projects/p1/jobs/j1']}>
        <Panel client={client} fresh={2} onFreshTaken={taken} opened={opened} />
      </MemoryRouter>,
    );
    await chat.flush(m, 10);
    expect(taken).toHaveBeenCalledTimes(1);
    expect(opened.at(-1)).toBe(null);
    expect(thread(m)).not.toContain('gloss it');
    await m.unmount();
  });
});
