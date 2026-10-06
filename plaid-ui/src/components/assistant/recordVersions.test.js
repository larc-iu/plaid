import { describe, it, expect, vi } from 'vitest';

// The record has two writers, this page and the service, and other tabs write
// it too. Each write names the version of the record the page's copy was read
// at, and one that another write overtook (409) is made again on the record
// as stored (REV-FX9-RUNTIME, the ruling on A1-IGT-1's read-then-write gap):
// the page's older copy never puts back a record without the service's answer.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { attachJob, readConv, startApply, startTurn } = await import('./jobs.js');

// The user's private data as core keeps it: a value and a version per key,
// and a write naming a version the entry is no longer at refused with 409.
const versionedStore = () => {
  const data = new Map();
  const before = [];
  const userData = {
    get: vi.fn(async (_user, key) => {
      if (!data.has(key)) throw Object.assign(new Error('No such entry'), { status: 404 });
      const { value, version } = data.get(key);
      return { key, value: structuredClone(value), version };
    }),
    put: vi.fn(async (_user, key, value, { version } = {}) => {
      before.shift()?.(key);
      const stored = data.get(key)?.version ?? 0;
      if (version !== undefined && version !== stored) {
        throw Object.assign(new Error('HTTP 409 version-mismatch'), {
          status: 409,
          responseData: { error: 'version-mismatch', version: stored },
        });
      }
      data.set(key, { value: structuredClone(value), version: stored + 1 });
      return { key, version: stored + 1 };
    }),
  };
  // What another writer does just before the page's next writes: one hook a write.
  const meanwhile = (...hooks) => before.push(...hooks);
  const write = (key, value) => {
    const version = (data.get(key)?.version ?? 0) + 1;
    data.set(key, { value: structuredClone(value), version });
  };
  return { data, userData, meanwhile, write };
};

const KEYS = { conv: 'igt:assistant:proj:conv:c1', meta: 'igt:assistant:proj:meta:c1' };
const q1 = { kind: 'user', text: 'Gloss sentence 4.', createdAt: '2026-10-06T00:00:00.000Z' };
const a1 = { kind: 'assistant', text: 'Glossed.', plan: null, citations: [], status: null };
const q2 = { kind: 'user', text: 'And sentence 5?', createdAt: '2026-10-06T00:05:00.000Z' };

const setup = () => {
  const s = versionedStore();
  const client = {
    userData: s.userData,
    messages: {
      requestService: vi.fn(async () => ({ kind: 'turn', message: 'ok' })),
      attachServiceRequest: vi.fn(async () => {
        throw Object.assign(new Error('Not found'), { status: 404 });
      }),
    },
  };
  const store = { client, userId: 'u1', app: 'igt', projectId: 'proj' };
  const value = (key) => s.data.get(key)?.value;
  return { ...s, client, store, value };
};

// The page read the record with the question, then gave up on the request.
const seedAsked = (t) => {
  t.write(KEYS.conv, { messages: [{ role: 'user', content: q1.text }], display: [q1] });
  t.write(KEYS.meta, { id: 'c1', title: 't', updatedAt: 'a', pending: null });
};

// The service's late answer, written behind the page's back.
const answerLands = (t) => {
  t.write(KEYS.conv, {
    messages: [
      { role: 'user', content: q1.text },
      { role: 'assistant', content: 'Glossed.' },
    ],
    display: [q1, a1],
  });
  t.write(KEYS.meta, { id: 'c1', title: 't', updatedAt: 'b', pending: null });
};

const asking = (base, item) => ({
  ...base,
  messages: [...base.messages, { role: 'user', content: item.text }],
  display: [...base.display, item],
});

describe('a message sent from a copy older than the record', () => {
  it('goes after the answer that landed since, rather than over it', async () => {
    const t = setup();
    seedAsked(t);
    const { conv: page } = await readConv(t.store, 'c1');
    answerLands(t);
    const j = startTurn({
      store: t.store,
      service: { serviceId: 's1' },
      conv: asking(page, q2),
      prevMeta: null,
    });
    await j.promise;
    const stored = t.value(KEYS.conv);
    expect(stored.display.map((d) => d.text)).toEqual([q1.text, a1.text, q2.text]);
    expect(stored.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(t.client.messages.requestService).toHaveBeenCalledTimes(1);
    expect(j.rebased).toBe(true);
    expect(j.conv.display).toHaveLength(3);
  });

  it('is not sent while another tab has a turn under way, and goes back to the composer', async () => {
    const t = setup();
    seedAsked(t);
    const { conv: page } = await readConv(t.store, 'c1');
    // Another tab asked meanwhile.
    t.write(KEYS.conv, { messages: [], display: [q1, a1, q2] });
    t.write(KEYS.meta, {
      id: 'c1',
      updatedAt: 'c',
      pending: { kind: 'turn', requestId: 'r-other', serviceId: 's1', startedAt: 'x' },
    });
    const mine = { kind: 'user', text: 'Mine.', createdAt: '2026-10-06T00:06:00.000Z' };
    const j = startTurn({
      store: t.store,
      service: { serviceId: 's1' },
      conv: asking(page, mine),
      prevMeta: null,
    });
    await j.promise;
    expect(j.declined).toBe(true);
    expect(j.unsent).toBe('Mine.');
    expect(t.value(KEYS.conv).display.map((d) => d.text)).toEqual([q1.text, a1.text, q2.text]);
    expect(t.value(KEYS.meta).pending.requestId).toBe('r-other');
    expect(t.client.messages.requestService).not.toHaveBeenCalled();
    // The other tab's turn is followed here.
    expect(t.client.messages.attachServiceRequest).toHaveBeenCalledWith(
      'proj',
      'r-other',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('as a retry is not sent once the answer it asks for has landed', async () => {
    const t = setup();
    seedAsked(t);
    const { conv: page } = await readConv(t.store, 'c1');
    answerLands(t);
    const lost = { kind: 'error', lost: true, text: 'No answer came back for this message.' };
    const retried = { ...q1, retry: true, createdAt: '2026-10-06T00:07:00.000Z' };
    const j = startTurn({
      store: t.store,
      service: { serviceId: 's1' },
      conv: { ...page, display: [...page.display, lost, retried], messages: page.messages },
      prevMeta: null,
    });
    await j.promise;
    expect(j.declined).toBe(true);
    expect(j.unsent).toBeUndefined();
    expect(j.result.conv.display.map((d) => d.kind)).toEqual(['user', 'assistant']);
    expect(t.value(KEYS.conv).display.map((d) => d.kind)).toEqual(['user', 'assistant']);
    expect(t.client.messages.requestService).not.toHaveBeenCalled();
  });
});

describe('a turn the page settles while the service writes', () => {
  it('shows the answer that landed between its read and its write', async () => {
    const t = setup();
    t.write(KEYS.conv, { messages: [{ role: 'user', content: q1.text }], display: [q1] });
    const pending = { kind: 'turn', requestId: 'r1', serviceId: 's1', startedAt: 'x' };
    t.write(KEYS.meta, { id: 'c1', updatedAt: 'a', pending });
    const { conv } = await readConv(t.store, 'c1');
    // The rejoin answers 404 (a restart). The page reads the record, and just
    // before its write clearing the marker, the service writes its answer.
    t.meanwhile(() => answerLands(t));
    const j = attachJob({ store: t.store, conv, meta: { id: 'c1', pending } });
    await j.promise;
    expect(t.value(KEYS.conv).display.map((d) => d.kind)).toEqual(['user', 'assistant']);
    expect(j.result.conv.display.map((d) => d.kind)).toEqual(['user', 'assistant']);
    expect(t.value(KEYS.meta).pending).toBe(null);
  });
});

describe('an approval', () => {
  it('is not asked for once the plan was decided in another tab', async () => {
    const t = setup();
    const planned = { ...a1, plan: { id: 'p1', summary: '1 change', ops: [{}] }, status: null };
    t.write(KEYS.conv, { messages: [], display: [q1, planned] });
    t.write(KEYS.meta, { id: 'c1', updatedAt: 'a', pending: null });
    const { conv } = await readConv(t.store, 'c1');
    t.write(KEYS.conv, { messages: [], display: [q1, { ...planned, status: 'discarded' }] });
    t.write(KEYS.meta, { id: 'c1', updatedAt: 'b', pending: null });
    const j = startApply({
      store: t.store,
      service: { serviceId: 's1' },
      conv,
      prevMeta: null,
      plan: planned.plan,
      asHuman: false,
    });
    await j.promise;
    expect(j.declined).toBe(true);
    expect(t.client.messages.requestService).not.toHaveBeenCalled();
    expect(j.result.conv.display[1].status).toBe('discarded');
    expect(t.value(KEYS.meta).pending).toBe(null);
  });
});

describe('an answer whose save got no answer', () => {
  it('is not written twice when the transcript landed and only the marker is left', async () => {
    const t = setup();
    const item = { ...a1, createdAt: '2026-10-06T00:01:00.000Z' };
    t.client.messages.requestService = vi.fn(async () => {
      // The service's transcript landed, its sidebar entry did not.
      t.write(KEYS.conv, {
        messages: [
          { role: 'user', content: q1.text },
          { role: 'assistant', content: 'Glossed.' },
        ],
        display: [q1, item],
      });
      return {
        kind: 'turn',
        message: 'Glossed.',
        warning: 'Saving the conversation got no answer, so this answer may not be in the record.',
        item,
      };
    });
    t.write(KEYS.meta, { id: 'c1', updatedAt: 'a', pending: null });
    const { conv } = await readConv(t.store, 'c1').catch(() => ({ conv: null }));
    const start = conv ?? {
      id: 'c1',
      messages: [{ role: 'user', content: q1.text }],
      display: [q1],
      rev: { conv: 0, meta: 1 },
    };
    const j = startTurn({
      store: t.store,
      service: { serviceId: 's1' },
      conv: start,
      prevMeta: null,
    });
    await j.promise;
    expect(t.value(KEYS.conv).display.map((d) => d.kind)).toEqual(['user', 'assistant']);
    expect(t.value(KEYS.meta).pending).toBe(null);
  });
});
