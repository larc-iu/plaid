import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// No conversation is started FOR anything any more: a job is set up by asking
// the assistant in whatever conversation is open (the owner, 2026-11-17). A
// conversation the old Set up job started keeps `purpose` in its entry, and
// is listed, opened and continued as any other. A link to the full tab that
// still asks for a purpose opens the tab as usual.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { renderComponent } = await import('../../test/renderComponent.jsx');
const { AssistantChat } = await import('./AssistantChat.jsx');
const { ConversationRows } = await import('./ConversationList.jsx');
const { AssistantTab } = await import('./AssistantTab.jsx');
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
      renderEmpty={() => <p data-testid="empty">Ask about Lamkang A.</p>}
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

describe('a conversation and its purpose', () => {
  it('a new conversation asked for sends no purpose, and reads as any other', async () => {
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
    expect(sends(client)[0]).toMatchObject({ create: true });
    expect(sends(client)[0]).not.toHaveProperty('purpose');
    await m.unmount();
  });

  it('a saved conversation whose entry has a purpose is listed by its title alone, and continues', async () => {
    const client = chatClient({
      conv: CONV,
      meta: { ...chat.META, title: 'Gloss the stories', purpose: 'job-setup' },
    });
    const m = await mount(client, { fresh: null, onFreshTaken: vi.fn(), seen: {} });
    await chat.flush(m, 10);
    const row = m.container.querySelector(`a[href*="conversation=c1"]`);
    expect(row?.textContent).toContain('Gloss the stories');
    expect(row?.textContent).not.toContain('Job setup');
    await chat.typeAndSend(m, 'Only Gloss.');
    await chat.flush(m, 10);
    const [sent] = sends(client);
    expect(sent).toMatchObject({ create: false, text: 'Only Gloss.' });
    expect(sent).not.toHaveProperty('purpose');
    await m.unmount();
  });

  it('a saved conversation with a purpose and no title is Untitled, as any other', async () => {
    const client = chatClient({
      conv: CONV,
      meta: { ...chat.META, title: '', purpose: 'job-setup' },
    });
    const m = await mount(client, { fresh: null, onFreshTaken: vi.fn(), seen: {} });
    await chat.flush(m, 10);
    const row = m.container.querySelector(`a[href*="conversation=c1"]`);
    expect(row?.textContent).toContain('Untitled');
    expect(row?.textContent).not.toContain('Job setup');
    await m.unmount();
  });

  it('the full tab at a link that asks for a purpose opens as usual', async () => {
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
    expect(m.container.textContent).not.toContain('Say what the job should do.');
    expect(m.container.textContent).not.toContain('Job setup');
    await chat.typeAndSend(m, 'Gloss the stories.');
    await chat.flush(m, 10);
    expect(sends(client).at(-1)).not.toHaveProperty('purpose');
    await m.unmount();
  });
});
