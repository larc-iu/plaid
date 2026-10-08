import { describe, it, expect, vi, beforeEach } from 'vitest';

// One thing at a time per conversation, decided against the record as stored
// (H10-RECORD, the polish campaign of 2026-10-02). A message, an approval and
// a discard each claim the conversation (its sidebar entry, written with a
// marker and the version the page last read) before they change it, and the
// one that loses reads the record again and finds the winner there.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { notifyError, notifyWarning } = await import('../../lib/notify.js');
const {
  DELETED,
  attachJob,
  applyToasts,
  discardPlan,
  jobs,
  persistConv,
  planDiscarded,
  readConv,
  startApply,
  startTurn,
} = await import('./jobs.js');

// The user's private data as core keeps it: a value and a version per key,
// and a write naming a version the entry is no longer at refused with 409.
// `before` hooks run just before the page's next write lands, one a write:
// what another tab or the service does at that moment.
const versionedStore = () => {
  const data = new Map();
  const before = [];
  const writes = [];
  const userData = {
    get: vi.fn(async (_user, key) => {
      if (!data.has(key)) throw Object.assign(new Error('No such entry'), { status: 404 });
      const { value, version } = data.get(key);
      return { key, value: structuredClone(value), version };
    }),
    put: vi.fn(async (_user, key, value, { version } = {}) => {
      await before.shift()?.(key);
      const stored = data.get(key)?.version ?? 0;
      if (version !== undefined && version !== stored) {
        throw Object.assign(new Error('HTTP 409 version-mismatch'), { status: 409 });
      }
      data.set(key, { value: structuredClone(value), version: stored + 1 });
      writes.push(key);
      return { key, version: stored + 1 };
    }),
  };
  const write = (key, value) => {
    const version = (data.get(key)?.version ?? 0) + 1;
    data.set(key, { value: structuredClone(value), version });
  };
  return { data, userData, before, writes, write };
};

const KEYS = { conv: 'igt:assistant:proj:conv:c1', meta: 'igt:assistant:proj:meta:c1' };
const q1 = { kind: 'user', text: 'Gloss sentence 4.', createdAt: '2026-10-06T00:00:00.000Z' };
const plan = { id: 'p1', summary: '33 field values', ops: [{ kind: 'x' }] };
const a1 = { kind: 'assistant', text: 'Here is a plan.', plan, citations: [], status: null };

const setup = () => {
  const s = versionedStore();
  const client = {
    userData: s.userData,
    messages: {
      // A turn under way, as long as the test looks.
      requestService: vi.fn(() => new Promise(() => {})),
      attachServiceRequest: vi.fn(() => new Promise(() => {})),
    },
  };
  const store = { client, userId: 'u1', app: 'igt', projectId: 'proj' };
  const value = (key) => s.data.get(key)?.value;
  s.write(KEYS.conv, {
    messages: [
      { role: 'user', content: q1.text },
      { role: 'assistant', content: a1.text },
    ],
    display: [q1, a1],
  });
  s.write(KEYS.meta, { id: 'c1', title: 't', updatedAt: 'a', pending: null });
  return { ...s, client, store, value };
};

const marker = (kind, requestId, extra = {}) => ({
  kind,
  requestId,
  serviceId: 's1',
  startedAt: new Date().toISOString(),
  ...extra,
});

const asking = (base, text, at = '2026-10-06T00:05:00.000Z') => ({
  ...base,
  messages: [...base.messages, { role: 'user', content: text }],
  display: [...base.display, { kind: 'user', text, createdAt: at }],
});

const service = { serviceId: 's1' };

beforeEach(() => {
  jobs.clear();
  notifyError.mockClear();
  notifyWarning.mockClear();
});

describe('two tabs sending at once (H10-RECORD-4)', () => {
  it('run one turn: the second tab finds the first one under way and keeps its text', async () => {
    const t = setup();
    const { conv: tab1 } = await readConv(t.store, 'c1');
    const { conv: tab2 } = await readConv(t.store, 'c1');
    const one = startTurn({
      store: t.store,
      service,
      conv: asking(tab1, 'Tab one.'),
      prevMeta: null,
    });
    const two = startTurn({
      store: t.store,
      service,
      conv: asking(tab2, 'Tab two.', '2026-10-06T00:05:00.060Z'),
      prevMeta: null,
    });
    await two.promise;
    await vi.waitFor(() => expect(t.client.messages.requestService).toHaveBeenCalled());
    expect(t.client.messages.requestService).toHaveBeenCalledTimes(1);
    expect(two.declined).toBe(true);
    expect(two.unsent).toBe('Tab two.');
    expect(two.why).toBe('A message is being answered in another tab.');
    const stored = t.value(KEYS.conv);
    expect(stored.display.map((d) => d.text)).toEqual([q1.text, a1.text, 'Tab one.']);
    expect(stored.messages.filter((m) => m.role === 'user')).toHaveLength(2);
    // The marker is the first tab's, and the second tab follows that turn.
    expect(t.value(KEYS.meta).pending.requestId).toBe(one.requestId);
    expect(t.client.messages.attachServiceRequest).toHaveBeenCalledWith(
      'proj',
      one.requestId,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('claims before the transcript, so a tab reading between the two writes sees the claim', async () => {
    // The hunter's run 1: tab X's transcript landed, tab Y read the record
    // before X's sidebar write, found no marker and asked a second time.
    const t = setup();
    const { conv: page } = await readConv(t.store, 'c1');
    startTurn({ store: t.store, service, conv: asking(page, 'Mine.'), prevMeta: null });
    await vi.waitFor(() => expect(t.client.messages.requestService).toHaveBeenCalled());
    expect(t.writes.slice(-2)).toEqual([KEYS.meta, KEYS.conv]);
  });

  it('a send from a copy that never showed another tab’s message is not sent after it', async () => {
    const t = setup();
    const { conv: page } = await readConv(t.store, 'c1');
    // The other tab's turn ran and was answered, marker cleared.
    const q2 = { kind: 'user', text: 'Theirs.', createdAt: '2026-10-06T00:04:00.000Z' };
    const a2 = { kind: 'assistant', text: 'Answered.', createdAt: '2026-10-06T00:04:30.000Z' };
    t.write(KEYS.conv, { messages: [], display: [q1, a1, q2, a2] });
    t.write(KEYS.meta, { id: 'c1', updatedAt: 'b', pending: null });
    const j = startTurn({ store: t.store, service, conv: asking(page, 'Mine.'), prevMeta: null });
    await j.promise;
    expect(j.declined).toBe(true);
    expect(j.unsent).toBe('Mine.');
    expect(j.why).toBe('A message was sent in another tab.');
    expect(j.result.conv.display.map((d) => d.text)).toEqual([
      q1.text,
      a1.text,
      'Theirs.',
      'Answered.',
    ]);
    expect(t.client.messages.requestService).not.toHaveBeenCalled();
  });
});

describe('a message sent while an approval runs (H10-RECORD-2)', () => {
  it('waits: nothing is sent, the text stays, and the approval is followed', async () => {
    const t = setup();
    const { conv: page } = await readConv(t.store, 'c1');
    const apply = marker('apply', 'r-apply', { planId: 'p1' });
    t.write(KEYS.meta, { id: 'c1', updatedAt: 'b', pending: apply });
    const j = startTurn({ store: t.store, service, conv: asking(page, 'Next?'), prevMeta: null });
    await j.promise;
    expect(j.declined).toBe(true);
    expect(j.unsent).toBe('Next?');
    expect(j.why).toBe('The changes are being applied.');
    expect(t.value(KEYS.meta).pending.requestId).toBe('r-apply');
    expect(t.value(KEYS.conv).display).toHaveLength(2);
    expect(t.client.messages.requestService).not.toHaveBeenCalled();
    expect(t.client.messages.attachServiceRequest.mock.calls[0][1]).toBe('r-apply');
  });

  it('a write leaving its own marker never puts it over an approval’s', async () => {
    const t = setup();
    const { conv: page } = await readConv(t.store, 'c1');
    const apply = marker('apply', 'r-apply', { planId: 'p1' });
    // The approval's claim lands between this write's transcript and its
    // sidebar entry.
    t.before.push(null, () => t.write(KEYS.meta, { id: 'c1', updatedAt: 'b', pending: apply }));
    const mine = marker('turn', 'r-mine');
    await persistConv(t.store, page, { id: 'c1', updatedAt: 'c', pending: mine });
    expect(t.value(KEYS.meta).pending.requestId).toBe('r-apply');
  });

  it('an approval is not claimed over a turn under way', async () => {
    const t = setup();
    const { conv: page } = await readConv(t.store, 'c1');
    t.write(KEYS.meta, { id: 'c1', updatedAt: 'b', pending: marker('turn', 'r-turn') });
    const j = startApply({
      store: t.store,
      service,
      conv: page,
      prevMeta: null,
      plan,
      asHuman: false,
    });
    await j.promise;
    expect(j.declined).toBe(true);
    expect(j.why).toBe('A message is being answered in another tab.');
    expect(t.value(KEYS.meta).pending.requestId).toBe('r-turn');
    expect(t.client.messages.requestService).not.toHaveBeenCalled();
  });

  it('a duplicate approval says so', () => {
    applyToasts(
      {
        outcome: {
          kind: 'applied',
          duplicate: true,
          message: 'This plan was already applied. Nothing was written again.',
        },
      },
      '1 change',
      { docked: true },
    );
    expect(notifyWarning).toHaveBeenCalledWith(
      'This plan was already applied. Nothing was written again.',
      'Already applied',
    );
  });
});

describe('a discard while the plan is being applied (H10-RECORD-1)', () => {
  it('is refused, the record and the approval’s marker are left as they are', async () => {
    const t = setup();
    const { conv: page } = await readConv(t.store, 'c1');
    const apply = marker('apply', 'r-apply', { planId: 'p1' });
    // Tab 1 approved, and the service has written what the plan found.
    t.write(KEYS.meta, { id: 'c1', updatedAt: 'b', pending: apply });
    t.write(KEYS.conv, {
      messages: t.value(KEYS.conv).messages,
      display: [q1, { ...a1, plan: { ...plan, expansion: { 0: 'x' } } }],
    });
    const out = await discardPlan({ store: t.store, conv: page, prevMeta: null, planId: 'p1' });
    expect(out.declined).toBe(true);
    expect(out.fresh.meta.pending.requestId).toBe('r-apply');
    const stored = t.value(KEYS.conv);
    expect(stored.display[1].status).toBe(null);
    expect(stored.messages.some((m) => /discarded/.test(m.content))).toBe(false);
    expect(t.value(KEYS.meta).pending.requestId).toBe('r-apply');
  });

  it('is refused on the page’s word when the entry it has names the approval', async () => {
    const t = setup();
    const { conv: page } = await readConv(t.store, 'c1');
    const apply = marker('apply', 'r-apply', { planId: 'p1' });
    t.write(KEYS.meta, { id: 'c1', updatedAt: 'b', pending: apply });
    const writes = t.writes.length;
    const out = await discardPlan({
      store: t.store,
      conv: page,
      prevMeta: { id: 'c1', pending: apply },
      planId: 'p1',
    });
    expect(out.declined).toBe(true);
    expect(t.writes.length).toBe(writes);
  });

  it('an approval asked while a discard holds the conversation is not asked', async () => {
    const t = setup();
    const { conv: page } = await readConv(t.store, 'c1');
    // The discard's claim lands just before the approval's.
    t.before.push(() =>
      t.write(KEYS.meta, { id: 'c1', updatedAt: 'b', pending: marker('discard', 'r-d') }),
    );
    const j = startApply({
      store: t.store,
      service,
      conv: page,
      prevMeta: null,
      plan,
      asHuman: false,
    });
    await j.promise;
    expect(j.declined).toBe(true);
    expect(t.client.messages.requestService).not.toHaveBeenCalled();
  });

  it('a discard rebuilt on a version conflict keeps another request’s marker', async () => {
    const t = setup();
    const { conv: page } = await readConv(t.store, 'c1');
    // Between the discard's claim and its transcript, the service of an
    // earlier request writes the transcript and keeps whatever marker stands.
    t.before.push(null, () => {
      t.write(KEYS.conv, { messages: t.value(KEYS.conv).messages, display: [q1, a1] });
    });
    const out = await discardPlan({ store: t.store, conv: page, prevMeta: null, planId: 'p1' });
    expect(out.declined).toBeUndefined();
    expect(t.value(KEYS.conv).display[1].status).toBe('discarded');
    expect(t.value(KEYS.meta).pending).toBe(null);
  });

  it('a plain discard claims, writes, and leaves no marker', async () => {
    const t = setup();
    const { conv: page } = await readConv(t.store, 'c1');
    const out = await discardPlan({ store: t.store, conv: page, prevMeta: null, planId: 'p1' });
    expect(out.conv.display[1].status).toBe('discarded');
    expect(t.writes.slice(-3)).toEqual([KEYS.meta, KEYS.conv, KEYS.meta]);
    expect(t.value(KEYS.meta).pending).toBe(null);
    expect(t.value(KEYS.conv).messages.at(-1).content).toBe(
      '(note) The user discarded the plan; nothing was changed.',
    );
  });
});

describe('an interrupted approval that may have written (H10-RECORD-3)', () => {
  it('cannot be discarded', () => {
    const conv = {
      messages: [],
      display: [q1, { ...a1, interrupted: true, plan: { ...plan, writing: true } }],
    };
    expect(planDiscarded(conv, 'p1')).toBe(null);
  });

  it('can be when its run certainly wrote nothing', () => {
    const conv = { messages: [], display: [q1, { ...a1, interrupted: true }] };
    expect(planDiscarded(conv, 'p1').display[1].status).toBe('discarded');
  });
});

describe('a conversation deleted in another tab (H10-RECORD-5)', () => {
  const deleted = async (t) => {
    const { conv: page } = await readConv(t.store, 'c1');
    t.data.delete(KEYS.conv);
    t.data.delete(KEYS.meta);
    return page;
  };

  it('takes a message without sending it, says so and keeps the text', async () => {
    const t = setup();
    const page = await deleted(t);
    const j = startTurn({
      store: t.store,
      service,
      conv: asking(page, 'Still there?'),
      prevMeta: null,
    });
    const result = await j.promise;
    expect(j.declined && j.gone).toBe(true);
    expect(j.why).toBe(DELETED);
    expect(j.unsent).toBe('Still there?');
    expect(result.meta).toBe(null);
    expect(result.conv.display).toEqual(page.display);
    expect(t.data.has(KEYS.conv)).toBe(false);
    expect(t.data.has(KEYS.meta)).toBe(false);
    expect(t.client.messages.requestService).not.toHaveBeenCalled();
  });

  it('takes an approval and a discard the same way', async () => {
    const t = setup();
    const page = await deleted(t);
    const j = startApply({
      store: t.store,
      service,
      conv: page,
      prevMeta: null,
      plan,
      asHuman: false,
    });
    const result = await j.promise;
    expect(j.gone).toBe(true);
    expect(result.meta).toBe(null);
    const out = await discardPlan({ store: t.store, conv: page, prevMeta: null, planId: 'p1' });
    expect(out.gone).toBe(true);
    expect(t.data.has(KEYS.meta)).toBe(false);
  });
});

describe('rejoining a request its page has not sent yet', () => {
  it('asks again while the marker is young, rather than settling it as lost', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const { conv } = await readConv(t.store, 'c1');
      let calls = 0;
      t.client.messages.attachServiceRequest = vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('Not found'), { status: 404 });
        // Sent by then, answered and written by the service.
        t.write(KEYS.conv, { messages: [], display: [q1, a1, { kind: 'assistant', text: 'ok' }] });
        t.write(KEYS.meta, { id: 'c1', updatedAt: 'c', pending: null });
        return { kind: 'turn', message: 'ok' };
      });
      const pending = marker('turn', 'r-young');
      t.write(KEYS.meta, { id: 'c1', updatedAt: 'b', pending });
      const j = attachJob({ store: t.store, conv, meta: { id: 'c1', pending } });
      await vi.advanceTimersByTimeAsync(5000);
      await j.promise;
      expect(calls).toBe(3);
      expect(j.error).toBe(null);
      expect(j.result.conv.display.at(-1).text).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});
