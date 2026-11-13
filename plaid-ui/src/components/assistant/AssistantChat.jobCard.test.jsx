import { describe, it, expect, vi, beforeEach } from 'vitest';

// A reply carrying a job card (an unattended job the app's assistant drafted):
// the chat draws it with the app's own card (adapter.JobCard) and, when the
// card ends, tells the service with the op `job`, shows the end at once and
// then the record as the service wrote it. An app with no JobCard draws none.
// Read-only where the conversation is another tab's. The Markdown export
// says it too. The service's half is plaid-agent's test_job_card.py.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { all } = await import('../../test/renderComponent.jsx');
const { jobs, serviceCache } = await import('./jobs.js');
const chat = await import('../../test/assistantChat.jsx');
const { conversationToMarkdown } = await import('./exportMarkdown.js');
const { ADAPTER, KEYS, META, chatClient, mountChat } = chat;

const CARD = {
  id: 'card-1',
  all: false,
  count: 1,
  documents: [{ id: 'd1', name: 'Text 1' }],
  tasks: ['gloss'],
  brief: 'Gloss ka as go.',
  summary: '1 document, gloss',
  status: null,
};

const CONV = {
  messages: [
    { role: 'user', content: 'gloss it overnight' },
    { role: 'assistant', content: 'Here is the job.' },
  ],
  display: [
    { kind: 'user', text: 'gloss it overnight' },
    { kind: 'assistant', text: 'Here is the job.', plan: null, job: CARD },
  ],
};

// The app's card, as the chat hands it its props.
const seen = [];
const JobCard = (props) => {
  seen.push(props);
  return (
    <div data-testid="card">
      {props.card.status ?? 'waiting'}
      {!props.readOnly && (
        <button
          type="button"
          onClick={() => props.onSettle({ outcome: 'started', brief: 'Gloss ka as come.' })}
        >
          Start
        </button>
      )}
    </div>
  );
};

const fakeClient = (meta = META) =>
  chatClient({ meta, conv: structuredClone(CONV), answer: 'Answered.' });
const flush = (m, times = 6) => chat.flush(m, times);
const cardText = (m) => m.container.querySelector('[data-testid="card"]')?.textContent ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  jobs.clear();
  serviceCache.clear();
  seen.length = 0;
});

describe('a job card in the chat', () => {
  it('is drawn by the app\'s card with the session client, and no "sent no text" line', async () => {
    const client = fakeClient();
    const m = await mountChat(client, { adapter: { ...ADAPTER, JobCard } });
    await flush(m);
    expect(cardText(m)).toContain('waiting');
    const props = seen.at(-1);
    expect(props.card.id).toBe('card-1');
    expect(props.projectId).toBe('p1');
    expect(props.client).toBe(client);
    expect(props.readOnly).toBe(false);
    expect(props.busy).toBe(false);
    expect(m.container.textContent).not.toContain('The assistant sent no text.');
  });

  it('tells the service how the card ended, and shows the record it wrote', async () => {
    const client = fakeClient();
    const m = await mountChat(client, { adapter: { ...ADAPTER, JobCard } });
    await flush(m);
    await m.step(() =>
      all(m.container, 'button')
        .find((b) => b.textContent === 'Start')
        .click(),
    );
    await flush(m);
    const sent = client.messages.requestService.mock.calls
      .map((c) => c[2])
      .find((d) => d.op === 'job');
    expect(sent).toMatchObject({
      op: 'job',
      conversationId: 'c1',
      cardId: 'card-1',
      outcome: 'started',
    });
    expect(cardText(m)).toContain('started');
    const stored = client.records.get(KEYS.conv).display[1].job;
    expect(stored).toMatchObject({ status: 'started', jobId: 'card-1' });
  });

  it('is read-only where another tab holds the conversation', async () => {
    const client = fakeClient({ ...META, holder: { tab: 'other', at: new Date().toISOString() } });
    const m = await mountChat(client, { adapter: { ...ADAPTER, JobCard } });
    await flush(m);
    expect(seen.at(-1).readOnly).toBe(true);
    expect(all(m.container, 'button').find((b) => b.textContent === 'Start')).toBeUndefined();
  });

  it('draws nothing for an app with no job card', async () => {
    const m = await mountChat(fakeClient());
    await flush(m);
    expect(cardText(m)).toBeNull();
  });

  it('says a reply sent no text where the app draws no card for it', async () => {
    const conv = structuredClone(CONV);
    conv.display[1].text = '';
    const m = await mountChat(chatClient({ meta: META, conv, answer: 'Answered.' }));
    await flush(m);
    expect(m.container.textContent).toContain('(The assistant sent no text.)');
  });
});

describe('a job card in the Markdown export', () => {
  it('says what it covers, how it ended and the instructions as sent', () => {
    const md = (job) =>
      conversationToMarkdown(
        { messages: [], display: [{ kind: 'assistant', text: 'Here.', job }] },
        { title: 'A thread' },
        { adapter: ADAPTER, projectId: 'p1', projectName: 'Lamkang A' },
      );
    expect(md(CARD)).toContain('**Proposed job:** Text 1. Segment and gloss. (Not yet started.)');
    expect(md(CARD)).toContain('Gloss ka as go.');
    const started = md({ ...CARD, status: 'started', sentBrief: 'Gloss ka as come.' });
    expect(started).toContain('(Started.)');
    expect(started).toContain('Gloss ka as come.');
    expect(md({ ...CARD, all: true, count: 9, status: 'discarded' })).toContain(
      '**Proposed job:** All documents (9). Segment and gloss. (Discarded.)',
    );
  });
});
