import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// A screen asks for a new conversation FOR something (subject.js
// `useStartConversation({purpose})`): "Set up job" asks for one marked
// `job-setup`. The panel says what to write in place of its usual line, the
// unsent row in the list is named for the purpose, and the send that creates
// the conversation carries the purpose. Nothing is sent by itself.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { renderComponent } = await import('../../test/renderComponent.jsx');
const { AssistantChat } = await import('./AssistantChat.jsx');
const { ConversationRows } = await import('./ConversationList.jsx');
const { AssistantTab } = await import('./AssistantTab.jsx');
const { AssistantPanel } = await import('./AssistantPanel.jsx');
const { jobs, lastOpen, serviceCache } = await import('./jobs.js');
const { purposeEmpty, purposeTitle } = await import('./purposes.js');
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

// The panel's own state, with what the bag hands the surface around the chat.
const Panel = ({ client, fresh, onFreshTaken, seen }) => {
  const [convId, setConvId] = useState(null);
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
      renderEmpty={({ purpose }) => (
        <p data-testid="empty">{purposeEmpty(purpose) ?? 'Ask about Lamkang A.'}</p>
      )}
      renderSidebar={({ listProps }) => {
        seen.rows = listProps.rows;
        return <ConversationRows {...listProps} />;
      }}
    />
  );
};

const mount = (client, props) =>
  renderComponent(
    <MemoryRouter initialEntries={['/projects/p1/jobs/j1']}>
      <Panel client={client} {...props} />
    </MemoryRouter>,
  );

const sends = (client) =>
  client.messages.requestService.mock.calls.map((c) => c[2]).filter((d) => d.op === 'send');

beforeEach(() => {
  vi.clearAllMocks();
  jobs.clear();
  lastOpen.clear();
  serviceCache.clear();
});

describe('a conversation started for a purpose', () => {
  it('names the purpose in its words: the row and the empty line', () => {
    expect(purposeTitle('job-setup')).toBe('Job setup');
    expect(purposeEmpty('job-setup')).toBe('Say what the job should do.');
    expect(purposeTitle(null)).toBe(null);
    expect(purposeEmpty('something-else')).toBe(null);
  });

  it('shows the purpose line and row, sends nothing by itself, and its first send carries the purpose', async () => {
    const client = chatClient({ conv: CONV });
    const seen = {};
    const m = await mount(client, {
      fresh: { seq: 1, purpose: 'job-setup' },
      onFreshTaken: vi.fn(),
      seen,
    });
    await chat.flush(m, 10);
    expect(m.container.querySelector('[data-testid=empty]').textContent).toBe(
      'Say what the job should do.',
    );
    expect(seen.rows[0]).toMatchObject({ draft: true, title: 'Job setup' });
    expect(m.container.textContent).toContain('Job setup');
    expect(sends(client)).toEqual([]);

    await chat.typeAndSend(m, 'Gloss the stories.');
    await chat.flush(m, 10);
    const [first] = sends(client);
    expect(first).toMatchObject({ create: true, text: 'Gloss the stories.', purpose: 'job-setup' });

    await chat.typeAndSend(m, 'Leave pele.');
    await chat.flush(m, 10);
    const second = sends(client)[1];
    expect(second.create).toBe(false);
    expect(second).not.toHaveProperty('purpose');
    await m.unmount();
  });

  it('a new conversation asked for with no purpose sends none, and reads as before', async () => {
    const client = chatClient({ conv: CONV });
    const seen = {};
    const m = await mount(client, { fresh: { seq: 1 }, onFreshTaken: vi.fn(), seen });
    await chat.flush(m, 10);
    expect(m.container.querySelector('[data-testid=empty]').textContent).toBe(
      'Ask about Lamkang A.',
    );
    expect(seen.rows[0]).toMatchObject({ draft: true, title: 'New conversation' });
    await chat.typeAndSend(m, 'Hello.');
    await chat.flush(m, 10);
    expect(sends(client)[0]).not.toHaveProperty('purpose');
    await m.unmount();
  });

  it('a saved conversation with no title is listed under its purpose', async () => {
    const client = chatClient({
      conv: CONV,
      meta: { ...chat.META, title: '', purpose: 'job-setup' },
    });
    const seen = {};
    const m = await mount(client, { fresh: null, onFreshTaken: vi.fn(), seen });
    await chat.flush(m, 10);
    const row = m.container.querySelector(`a[href*="conversation=c1"]`);
    expect(row?.textContent).toContain('Job setup');
    expect(row?.textContent).not.toContain('Untitled');
    await m.unmount();
  });

  it('the full tab opened for a purpose starts a conversation for it and drops the param', async () => {
    const client = chatClient({ conv: CONV });
    const at = {};
    const Where = () => {
      at.search = useLocation().search;
      return null;
    };
    const m = await renderComponent(
      <MemoryRouter initialEntries={['/projects/p1?tab=assistant&purpose=job-setup']}>
        <AssistantTab
          projectId="p1"
          projectName="Lamkang A"
          client={client}
          userId="u1"
          canWrite
          adapter={ADAPTER}
        />
        <Where />
      </MemoryRouter>,
    );
    await chat.flush(m, 10);
    expect(m.container.textContent).toContain('Say what the job should do.');
    expect(m.container.textContent).toContain('Job setup');
    expect(at.search).toBe('?tab=assistant');
    await chat.typeAndSend(m, 'Gloss the stories.');
    await chat.flush(m, 10);
    expect(sends(client)[0]).toMatchObject({ create: true, purpose: 'job-setup' });
    await m.unmount();
  });

  it('the docked panel says what to write for a purpose', async () => {
    const client = chatClient({ conv: CONV });
    const m = await renderComponent(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <AssistantPanel
          projectId="p1"
          projectName="Lamkang A"
          client={client}
          userId="u1"
          canWrite
          adapter={ADAPTER}
          fresh={{ seq: 1, purpose: 'job-setup' }}
          onFreshTaken={vi.fn()}
        />
      </MemoryRouter>,
    );
    await chat.flush(m, 10);
    expect(m.container.textContent).toContain('Say what the job should do.');
    expect(m.container.textContent).not.toContain('Ask about Lamkang A.');
    await m.unmount();
  });
});
