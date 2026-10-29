// The "Record as human-made" box belongs to its plan. A card the reader
// ticked, or one applied as human-made long ago, leaves it unticked on any
// other plan shown in the same place: another conversation's plan at the same
// index of its transcript, or a plan that takes a retried turn's place
// (R2-UI-1). Approve sends what the box on that plan says.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  notifyInfo: vi.fn(),
  dismissToast: vi.fn(),
}));

const { all, renderComponent } = await import('../../test/renderComponent.jsx');
const { jobs, serviceCache } = await import('./jobs.js');
const { ADAPTER, META, chatClient } = await import('../../test/assistantChat.jsx');
const { AssistantChat } = await import('./AssistantChat.jsx');
const { Turn } = await import('./Turn.jsx');

const planItem = (id, summary) => ({
  kind: 'assistant',
  text: 'A plan.',
  plan: { id, summary, labels: ['Set a gloss'], ops: [{ kind: 'x' }] },
  status: null,
});
const convOf = (planId, summary) => ({
  messages: [{ role: 'user', content: 'gloss it' }],
  display: [{ kind: 'user', text: 'gloss it' }, planItem(planId, summary)],
});

const element = (client, conversationId) => (
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

// Two conversations, the first holding `first` and the second plan B, each
// plan the first reply of its conversation.
const twoConversations = (first) => {
  const client = chatClient({ conv: first });
  client.serverNow = () => new Date();
  client.server = { limits: vi.fn().mockResolvedValue({}) };
  client.records.set('igt:assistant:p1:meta:c2', {
    ...META,
    id: 'c2',
    title: 'Another thread',
    updatedAt: '2026-09-13T00:00:00Z',
  });
  client.records.set('igt:assistant:p1:conv:c2', convOf('plan-B', 'Plan in B'));
  return client;
};

const settle = async (m) => {
  for (let i = 0; i < 8; i++) await m.step(() => new Promise((r) => setTimeout(r, 0)));
};

const approveSent = async (m, client) => {
  const approve = all(m.container, 'button').find(
    (b) => b.textContent.trim() === 'Approve and apply',
  );
  await m.step(() => approve.click());
  await settle(m);
  return client.messages.requestService.mock.calls
    .map((c) => c[2])
    .filter((d) => d.op === 'approve')
    .map((d) => [d.planId, d.asHuman]);
};

beforeEach(() => {
  vi.clearAllMocks();
  jobs.clear();
  serviceCache.clear();
});

describe('the human-made box belongs to its plan', () => {
  it('is not ticked on another conversation plan the reader never ticked', async () => {
    const client = twoConversations(convOf('plan-A', 'Plan in A'));
    const m = await renderComponent(element(client, 'c1'));
    await settle(m);
    expect(m.container.textContent).toContain('Plan in A');
    const box = m.container.querySelector('input[type=checkbox]');
    expect(box.checked).toBe(false);
    await m.step(() => box.click());
    expect(m.container.querySelector('input[type=checkbox]').checked).toBe(true);
    // The reader opens another conversation without approving plan A.
    await m.rerender(element(client, 'c2'));
    await settle(m);
    expect(m.container.textContent).toContain('Plan in B');
    expect(m.container.querySelector('input[type=checkbox]').checked).toBe(false);
    expect(await approveSent(m, client)).toEqual([['plan-B', false]]);
    await m.unmount();
  });

  it('is not ticked on an undecided plan because an older plan was recorded as human-made', async () => {
    const settled = convOf('plan-A', 'Plan in A');
    settled.display[1] = { ...settled.display[1], status: 'applied', asHuman: true };
    const client = twoConversations(settled);
    const m = await renderComponent(element(client, 'c1'));
    await settle(m);
    expect(m.container.textContent).toContain('Recorded as human-made.');
    await m.rerender(element(client, 'c2'));
    await settle(m);
    expect(m.container.textContent).toContain('Plan in B');
    expect(await approveSent(m, client)).toEqual([['plan-B', false]]);
    await m.unmount();
  });

  it('is not ticked on a new plan in the place of one the reader ticked', async () => {
    const turn = (id) => (
      <Turn item={planItem(id, `Plan ${id}`)} projectId="p1" adapter={ADAPTER} canWrite />
    );
    const m = await renderComponent(turn('plan-A'));
    await m.step(() => m.container.querySelector('input[type=checkbox]').click());
    expect(m.container.querySelector('input[type=checkbox]').checked).toBe(true);
    await m.rerender(turn('plan-B'));
    expect(m.container.textContent).toContain('Plan plan-B');
    expect(m.container.querySelector('input[type=checkbox]').checked).toBe(false);
    await m.unmount();
  });
});
