import { describe, it, expect, vi, afterEach } from 'vitest';

// How a turn ends when the request and the record disagree (FX9-RUNTIME):
// - A1-IGT-1: the server restarted under a running turn, so rejoining it
//   answered 404 and the page settled it as unanswered. The service went on
//   and wrote its answer minutes later, which the page never showed, and Retry
//   then wrote the page's older copy over it.
// - A2-UD-1: a stop the service ended the request on without writing the
//   record left the question unanswered, with no Stopped item.
// - A2-UD-2: a final save that failed lost the answer the service had.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { notifyError } = await import('../../lib/notify.js');
const { attachJob, jobListeners, recordAhead, startTurn } = await import('./jobs.js');

// The user's private data as core keeps it: a value per key, replaced whole.
const fakeStore = () => {
  const data = new Map();
  const userData = {
    get: vi.fn(async (_user, key) => {
      if (!data.has(key)) throw Object.assign(new Error('No such entry'), { status: 404 });
      return { key, value: structuredClone(data.get(key)) };
    }),
    put: vi.fn(async (_user, key, value) => {
      data.set(key, structuredClone(value));
      return {};
    }),
  };
  return { data, userData };
};

const KEYS = { conv: 'igt:assistant:proj:conv:c1', meta: 'igt:assistant:proj:meta:c1' };
const question = { kind: 'user', text: 'Gloss sentence 4.', createdAt: '2026-10-06T00:00:00.000Z' };
const answer = { kind: 'assistant', text: 'Glossed.', plan: null, citations: [], status: null };

const setup = (requestService) => {
  const { data, userData } = fakeStore();
  const client = {
    userData,
    messages: {
      requestService: vi.fn(requestService),
      attachServiceRequest: vi.fn(async () => {
        throw Object.assign(new Error('Not found'), { status: 404 });
      }),
    },
  };
  const store = { client, userId: 'u1', app: 'igt', projectId: 'proj' };
  const seen = [];
  const listen = (j) => seen.push(j);
  jobListeners.add(listen);
  return { data, store, seen, stop: () => jobListeners.delete(listen) };
};

const conv = () => ({
  id: 'c1',
  messages: [{ role: 'user', content: question.text }],
  display: [question],
});

describe('a turn whose request the server forgot', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the answer the service writes after the page settled it', async () => {
    vi.useFakeTimers();
    const { data, store, seen, stop } = setup();
    const pending = {
      kind: 'turn',
      requestId: 'r1',
      serviceId: 's1',
      startedAt: '2026-10-06T00:00:00Z',
    };
    data.set(KEYS.conv, { messages: conv().messages, display: conv().display });
    data.set(KEYS.meta, { id: 'c1', updatedAt: 'a', pending });
    const j = attachJob({ store, conv: conv(), meta: data.get(KEYS.meta) });
    await j.promise;
    // Settled as unanswered: the marker is cleared and nothing is added.
    expect(j.result.conv.display.map((d) => d.kind)).toEqual(['user']);
    expect(data.get(KEYS.meta).pending).toBe(null);
    // Two minutes later the service, still running, writes its answer.
    await vi.advanceTimersByTimeAsync(120000);
    data.set(KEYS.conv, {
      messages: [...conv().messages, { role: 'assistant', content: 'Glossed.' }],
      display: [question, answer],
    });
    data.set(KEYS.meta, { id: 'c1', updatedAt: 'b', pending: null });
    await vi.advanceTimersByTimeAsync(6000);
    const late = seen.filter((x) => x.late);
    expect(late).toHaveLength(1);
    expect(late[0].result.conv.display.map((d) => d.kind)).toEqual(['user', 'assistant']);
    stop();
  });

  it('is read again before a send or a retry writes the record', async () => {
    const { data, store } = setup();
    const page = conv();
    data.set(KEYS.conv, {
      messages: [...page.messages, { role: 'assistant', content: 'Glossed.' }],
      display: [question, answer],
    });
    data.set(KEYS.meta, { id: 'c1', updatedAt: 'b', pending: null });
    const ahead = await recordAhead(store, page, { id: 'c1', updatedAt: 'a' });
    expect(ahead.conv.display.map((d) => d.kind)).toEqual(['user', 'assistant']);
    // Nothing else wrote it since the page did: the whole record is not read.
    store.client.userData.get.mockClear();
    expect(await recordAhead(store, page, { id: 'c1', updatedAt: 'b' })).toBe(null);
    expect(store.client.userData.get).toHaveBeenCalledTimes(1);
    expect(await recordAhead(store, { ...page, draft: true })).toBe(null);
  });
});

describe('a turn the service ended without writing the record', () => {
  it('records a stop the service reported as a stop', async () => {
    const { data, store, stop } = setup(async () => ({ stopped: true }));
    const j = startTurn({ store, service: { serviceId: 's1' }, conv: conv(), prevMeta: null });
    await j.promise;
    const stored = data.get(KEYS.conv);
    expect(stored.display.map((d) => [d.kind, d.stopped])).toEqual([
      ['user', undefined],
      ['error', true],
    ]);
    // The question stays for the next turn to read.
    expect(stored.messages).toEqual(conv().messages);
    expect(data.get(KEYS.meta).pending).toBe(null);
    stop();
  });

  it('writes the answer the service could not save', async () => {
    notifyError.mockClear();
    const { data, store, stop } = setup(async () => ({
      kind: 'turn',
      message: 'Glossed.',
      warning: 'The conversation could not be saved: HTTP 500. This answer is not in the record.',
      item: { ...answer, plan: { id: 'p2', summary: '1 field value', ops: [] } },
    }));
    const earlier = {
      kind: 'assistant',
      text: 'Planned.',
      plan: { id: 'p1', ops: [] },
      status: null,
    };
    const start = { ...conv(), display: [earlier, question] };
    const j = startTurn({ store, service: { serviceId: 's1' }, conv: start, prevMeta: null });
    await j.promise;
    const stored = data.get(KEYS.conv);
    expect(stored.display.map((d) => d.kind)).toEqual(['assistant', 'user', 'assistant']);
    expect(stored.display[2].text).toBe('Glossed.');
    expect(stored.display[2].plan.id).toBe('p2');
    expect(stored.display[0].status).toBe('replaced');
    expect(stored.messages.at(-1)).toEqual({ role: 'assistant', content: 'Glossed.' });
    expect(data.get(KEYS.meta).pending).toBe(null);
    expect(notifyError).not.toHaveBeenCalled();
    stop();
  });

  it('says so when the page cannot save the answer either', async () => {
    notifyError.mockClear();
    const { store, stop } = setup(async () => ({
      kind: 'turn',
      message: 'Glossed.',
      item: answer,
    }));
    let puts = 0;
    const put = store.client.userData.put.getMockImplementation();
    store.client.userData.put.mockImplementation(async (...a) => {
      puts += 1;
      // The message and its marker land, the answer does not.
      if (puts > 2) throw Object.assign(new Error('Server error'), { status: 500 });
      return put(...a);
    });
    const j = startTurn({ store, service: { serviceId: 's1' }, conv: conv(), prevMeta: null });
    await j.promise;
    expect(j.result.conv.display.map((d) => d.kind)).toEqual(['user', 'assistant', 'error']);
    expect(j.result.conv.display[1].text).toBe('Glossed.');
    // The reason, not only that it failed (answerNotSaved.test.js).
    expect(notifyError).toHaveBeenCalledWith(
      expect.stringMatching(/^The answer was not saved\. \S/),
    );
    stop();
  });
});
