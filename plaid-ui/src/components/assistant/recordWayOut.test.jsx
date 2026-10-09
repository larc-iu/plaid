import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
// - A discard mark is held for no longer than its lease whatever the marking
//   tab's clock says, and a tab turned down by another tab's discard hears
//   when it is over.
// - A turn that ends on a conversation deleted elsewhere says so at once.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const {
  DELETED,
  attachJob,
  discardPlan,
  jobListeners,
  jobs,
  liveMarker,
  nothingLanded,
  planDiscarded,
  readConv,
  startTurn,
} = await import('./jobs.js');

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

  it('is discarded as any plan, with the usual note, once found so', async () => {
    const t = setup();
    const { conv } = await readConv(t.store, 'c1');
    expect(planDiscarded(conv, 'p1')).toBe(null);
    const out = await discardPlan({
      store: t.store,
      conv,
      prevMeta: null,
      planId: 'p1',
      unwritten: true,
    });
    const stored = t.data.get(KEYS.conv).value;
    expect(out.conv.display[1].status).toBe('discarded');
    expect(stored.display[1].status).toBe('discarded');
    expect(stored.messages.at(-1).content).toBe(
      '(note) The user discarded the plan; nothing was changed.',
    );
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

describe('a discard mark', () => {
  afterEach(() => vi.useRealTimers());

  it('holds for its lease, read from either side of the marking tab’s clock', () => {
    const at = (ms) => ({
      kind: 'discard',
      requestId: 'r',
      startedAt: new Date(Date.now() + ms).toISOString(),
    });
    expect(liveMarker(at(-10 * 1000))).not.toBe(null);
    expect(liveMarker(at(-60 * 1000))).toBe(null);
    // A tab whose clock runs ten minutes fast held the conversation for ten.
    expect(liveMarker(at(10 * 60 * 1000))).toBe(null);
    expect(liveMarker(at(5 * 1000))).not.toBe(null);
  });

  it('turns a message down while it stands, and the tab hears when it is gone', async () => {
    vi.useFakeTimers();
    const t = setup();
    const { conv } = await readConv(t.store, 'c1');
    const mark = { kind: 'discard', requestId: 'r-d', startedAt: new Date().toISOString() };
    t.write(KEYS.meta, { id: 'c1', title: 't', updatedAt: 'b', pending: mark });
    const seen = [];
    const listen = (j) => seen.push({ ...j });
    jobListeners.add(listen);
    try {
      const asked = {
        ...conv,
        messages: [...conv.messages, { role: 'user', content: 'Next.' }],
        display: [
          ...conv.display,
          { kind: 'user', text: 'Next.', createdAt: '2026-10-06T00:01:00.000Z' },
        ],
      };
      const j = startTurn({
        store: t.store,
        service: { serviceId: 's1' },
        conv: asked,
        prevMeta: null,
      });
      await vi.advanceTimersByTimeAsync(10);
      await j.promise;
      expect(j.declined).toBe(true);
      expect(j.why).toBe('This conversation is being changed in another tab.');
      expect(j.unsent).toBe('Next.');
      // The other tab's discard ends.
      t.write(KEYS.meta, { id: 'c1', title: 't', updatedAt: 'c', pending: null });
      await vi.advanceTimersByTimeAsync(2000);
      expect(seen.at(-1).cleared).toBe(true);
      expect(seen.at(-1).why).toBe(null);
      expect(t.client.messages.requestService).not.toHaveBeenCalled();
    } finally {
      jobListeners.delete(listen);
    }
  });
});

describe('rejoining a marker its tab dated in the future', () => {
  it('waits no longer than the grace from now', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const { conv } = await readConv(t.store, 'c1');
      t.client.messages.attachServiceRequest = vi.fn(async () => {
        throw Object.assign(new Error('Not found'), { status: 404 });
      });
      const pending = {
        kind: 'turn',
        requestId: 'r-skew',
        serviceId: 's1',
        startedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
      t.write(KEYS.meta, { id: 'c1', updatedAt: 'b', pending });
      const j = attachJob({ store: t.store, conv, meta: { id: 'c1', pending } });
      await vi.advanceTimersByTimeAsync(20 * 1000);
      await j.promise;
      expect(j.done).toBe(true);
      expect(t.client.messages.attachServiceRequest.mock.calls.length).toBeLessThan(20);
      expect(t.data.get(KEYS.meta).value.pending).toBe(null);
    } finally {
      vi.useRealTimers();
    }
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
      prevMeta: null,
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
