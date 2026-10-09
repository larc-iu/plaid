import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent, all, byText } from '../../test/renderComponent.jsx';
import { PlanCard } from './PlanCard.jsx';
import { AssistantComposer } from './AssistantComposer.jsx';
import { mentionsClient as fakeClient } from '../../test/fakeClient.js';

// Every marker and every card has a way out the reader can reach (REV-FX12, the
// review of the claim protocol, polish campaign of 2026-10-02).
//
// - An approval cut off after its run marked the plan as writing but before it
//   sent anything left a card that said "Some changes may be written" and
//   offered no Discard, so the only way out was to apply the plan.
//   The service checks it again when Discard is pressed (test_single_writer.py).
// - A turn that ends on a conversation deleted elsewhere says so at once.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { DELETED, jobs, nothingLanded, readConv, startTurn } = await import('./jobs.js');

const KEYS = { conv: 'igt:assistant:proj:conv:c1', meta: 'igt:assistant:proj:meta:c1' };
const q1 = { kind: 'user', text: 'Gloss it.', createdAt: '2026-10-06T00:00:00.000Z' };
const DOCS = [
  { id: 'd1', name: 'Story 1', version: 40, heldFrom: 40 },
  { id: 'd2', name: 'Story 2', version: 28, heldFrom: 28 },
];
const plan = { id: 'p1', summary: '11 field values', ops: [{ kind: 'x' }], documents: DOCS };
const cut = {
  kind: 'assistant',
  text: 'A plan.',
  plan: { ...plan, writing: { run: 'r1', inside: true } },
  status: null,
  interrupted: true,
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
  write(KEYS.conv, { messages: [{ role: 'user', content: q1.text }], display: [q1, cut] });
  write(KEYS.meta, { id: 'c1', title: 't', updatedAt: 'a', pending: null });
  return { data, write, client, store: { client, userId: 'u1', app: 'igt', projectId: 'proj' } };
};

beforeEach(() => jobs.clear());

describe('an approval cut off after marking its plan and before sending anything', () => {
  it('is found to have written nothing when every document it held is at the version held', async () => {
    expect(await nothingLanded(setup().store, cut)).toBe(true);
  });

  it('is not, when a document moved on, is gone, or held no version', async () => {
    expect(await nothingLanded(setup({ d1: 41, d2: 28 }).store, cut)).toBe(false);
    expect(await nothingLanded(setup({ d1: 40 }).store, cut)).toBe(false);
    const unheld = { ...cut, plan: { ...cut.plan, documents: [{ id: 'd1', version: 40 }] } };
    expect(await nothingLanded(setup().store, unheld)).toBe(false);
    // A plan that also writes a lexicon entry, which moves no document's version.
    const outside = { ...cut, plan: { ...cut.plan, writing: { run: 'r1', inside: false } } };
    expect(await nothingLanded(setup().store, outside)).toBe(false);
  });

  it('shows Discard and the plain line on its card', async () => {
    const view = await renderComponent(
      <PlanCard
        plan={cut.plan}
        status={null}
        interrupted
        nothingWritten
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
    const buttons = all(view.container, 'button').map((b) => b.textContent.trim());
    expect(buttons).toEqual(expect.arrayContaining(['Apply again', 'Discard']));
    expect(byText(view.container, 'p', 'Applying did not finish.')).not.toBeNull();
    await view.unmount();
  });
});

describe('the composer under a plan with no Discard', () => {
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

  it('invites applying it again, not a discard', async () => {
    const view = await mount('again');
    expect(view.container.querySelector('textarea').getAttribute('placeholder')).toBe(
      'Apply the plan above again, or keep talking',
    );
    await view.unmount();
  });

  it('still invites a decision when a plan can be discarded', async () => {
    const view = await mount('decide');
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
