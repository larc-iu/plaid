import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent, all, byText } from '../../test/renderComponent.jsx';
import { PlanCard } from './PlanCard.jsx';
import { AssistantComposer } from './AssistantComposer.jsx';
import { mentionsClient as fakeClient } from '../../test/fakeClient.js';

// Every marker and every card has a way out the reader can reach (REV-FX12, the
// review of the claim protocol, polish campaign of 2026-10-02).
//
// - An approval whose run died is settled partly applied by the service (Luke's
//   ruling R53, test_dead_approval.py): its card offers nothing more, and the
//   reader asks the assistant to plan the rest.
// - A turn that ends on a conversation deleted elsewhere says so at once.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { DELETED, jobs, readConv, startTurn } = await import('./jobs.js');

const KEYS = { conv: 'igt:assistant:proj:conv:c1', meta: 'igt:assistant:proj:meta:c1' };
const q1 = { kind: 'user', text: 'Gloss it.', createdAt: '2026-10-06T00:00:00.000Z' };
const plan = {
  id: 'p1',
  summary: '11 field values',
  changes: [{ label: 'Gloss = "house"' }],
  opCount: 1,
};
// As the service settles a plan whose approval's run died.
const died = {
  kind: 'assistant',
  text: 'A plan.',
  plan,
  status: 'partial',
  written: [],
  outcome: 'Applying stopped before it finished. Some changes may be written.',
};

const setup = (versions = { d1: 40, d2: 28 }) => {
  const data = new Map();
  const write = (key, value) =>
    data.set(key, { value: structuredClone(value), version: (data.get(key)?.version ?? 0) + 1 });
  const client = {
    userData: {
      get: vi.fn(async (_u, key) => {
        if (!data.has(key)) throw Object.assign(new Error('No such entry'), { status: 404 });
        const { value, version } = data.get(key);
        return { key, value: structuredClone(value), version };
      }),
      put: vi.fn(async (_u, key, value, { version } = {}) => {
        const stored = data.get(key)?.version ?? 0;
        if (version !== undefined && version !== stored) {
          throw Object.assign(new Error('HTTP 409'), { status: 409 });
        }
        data.set(key, { value: structuredClone(value), version: stored + 1 });
        return { key, version: stored + 1 };
      }),
    },
    documents: {
      get: vi.fn(async (id) => {
        if (!(id in versions)) throw Object.assign(new Error('gone'), { status: 404 });
        return { id, version: versions[id] };
      }),
    },
    messages: {
      requestService: vi.fn(() => new Promise(() => {})),
      attachServiceRequest: vi.fn(() => new Promise(() => {})),
    },
  };
  write(KEYS.conv, { messages: [{ role: 'user', content: q1.text }], display: [q1, died] });
  write(KEYS.meta, { id: 'c1', title: 't', updatedAt: 'a', pending: null });
  return { data, write, client, store: { client, userId: 'u1', app: 'igt', projectId: 'proj' } };
};

beforeEach(() => jobs.clear());

describe('an approval whose run died', () => {
  it('reads Partly applied, says changes may be written, and offers no decision', async () => {
    const view = await renderComponent(
      <PlanCard
        plan={died.plan}
        status={died.status}
        written={died.written}
        outcome={died.outcome}
        canWrite
        busy={false}
        onApprove={() => {}}
        onDiscard={() => {}}
        projectId="pr1"
        adapter={{
          textName: 'the text',
          groupOf: () => ({ key: 'd1', title: 'Story', href: null }),
          changePlace: () => null,
        }}
      />,
    );
    expect(view.container.textContent).toContain('Partly applied');
    expect(byText(view.container, 'p', died.outcome)).not.toBeNull();
    expect(all(view.container, 'button').map((b) => b.textContent.trim())).toEqual([]);
    await view.unmount();
  });
});

describe('the composer under a waiting plan', () => {
  const mount = (pendingPlan, extra = {}) =>
    renderComponent(
      <AssistantComposer
        client={fakeClient()}
        projectId="p1"
        choice={{
          service: { serviceId: 'a', serviceName: 'A' },
          assistants: [],
          choose: () => {},
          canChoose: false,
          wentOffline: false,
        }}
        text=""
        setText={() => {}}
        inputRef={{ current: null }}
        canSend
        onSend={() => {}}
        pendingPlan={pendingPlan}
        {...extra}
      />,
    );

  it('invites a decision', async () => {
    const view = await mount(true);
    expect(view.container.querySelector('textarea').getAttribute('placeholder')).toBe(
      'Approve or discard the plan above, or keep talking',
    );
    await view.unmount();
  });
});

describe('a turn whose conversation was deleted while it ran', () => {
  it('says so when it ends', async () => {
    const t = setup();
    const { conv } = await readConv(t.store, 'c1');
    let answer;
    t.client.messages.requestService = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const asked = {
      ...conv,
      messages: [...conv.messages, { role: 'user', content: 'Still there?' }],
      display: [
        ...conv.display,
        { kind: 'user', text: 'Still there?', createdAt: '2026-10-06T00:02:00.000Z' },
      ],
    };
    const j = startTurn({
      store: t.store,
      service: { serviceId: 's1' },
      conv: asked,
      text: 'Still there?',
    });
    await vi.waitFor(() => expect(t.client.messages.requestService).toHaveBeenCalled());
    t.data.delete(KEYS.conv);
    t.data.delete(KEYS.meta);
    answer({ kind: 'turn', message: 'Yes.' });
    const result = await j.promise;
    expect(j.gone).toBe(true);
    expect(j.why).toBe(DELETED);
    expect(result.meta).toBe(null);
    expect(t.data.has(KEYS.meta)).toBe(false);
  });
});
