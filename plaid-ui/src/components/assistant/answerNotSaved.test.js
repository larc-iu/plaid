import { describe, it, expect, vi } from 'vitest';

// The service's write of its answer was refused, so it handed the answer to
// the page, and the page's own save of it failed too (FX9-CAP).
// - The toast said "The answer was not saved." and nothing else: a record at
//   the size limit read the same as a server error, and nobody was told to
//   start a new conversation.
// - The answer's plan stayed drawn with Approve, as if stored. The service
//   reads a plan from the record to apply it, so approving it could only fail.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { notifyError } = await import('../../lib/notify.js');
const { jobListeners, startTurn } = await import('./jobs.js');

const KEYS = { conv: 'igt:assistant:proj:conv:c1', meta: 'igt:assistant:proj:meta:c1' };
const question = { kind: 'user', text: 'Gloss sentence 4.', createdAt: '2026-10-06T00:00:00.000Z' };
const plan = { id: 'p2', summary: '1 field value', changes: [{ label: 'a' }], ops: [{}] };
const earlier = { kind: 'assistant', text: 'Planned.', plan: { id: 'p1', ops: [] }, status: null };

// The user's private data as core keeps it, where every write after the
// message and its marker (the first two) is refused with `refusal`.
const setup = (item, refusal) => {
  const data = new Map();
  let puts = 0;
  const userData = {
    get: vi.fn(async (_user, key) => {
      if (!data.has(key)) throw Object.assign(new Error('No such entry'), { status: 404 });
      return { key, value: structuredClone(data.get(key)) };
    }),
    put: vi.fn(async (_user, key, value) => {
      puts += 1;
      if (puts > 2) throw refusal;
      data.set(key, structuredClone(value));
      return {};
    }),
  };
  const client = {
    userData,
    messages: {
      requestService: vi.fn(async () => ({
        kind: 'turn',
        message: item.text,
        warning: 'The conversation could not be saved. This answer is not in the record.',
        item,
      })),
    },
  };
  const listen = () => {};
  jobListeners.add(listen);
  return {
    data,
    store: { client, userId: 'u1', app: 'igt', projectId: 'proj' },
    stop: () => jobListeners.delete(listen),
  };
};

const run = async (item, refusal) => {
  notifyError.mockClear();
  const { data, store, stop } = setup(item, refusal);
  const conv = {
    id: 'c1',
    messages: [
      { role: 'assistant', content: 'Planned.' },
      { role: 'user', content: question.text },
    ],
    display: [earlier, question],
  };
  const j = startTurn({ store, service: { serviceId: 's1' }, conv, prevMeta: null });
  await j.promise;
  stop();
  return { j, data };
};

const tooLarge = Object.assign(new Error('Value exceeds 5242880 bytes'), { status: 413 });
const serverError = Object.assign(new Error('Forbidden'), { status: 403 });

describe('an answer neither the service nor the page could save', () => {
  it('says the conversation is full when the record is at its size limit', async () => {
    const { j } = await run(
      { kind: 'assistant', text: 'Glossed.', plan: null, status: null },
      tooLarge,
    );
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledWith(
      'This conversation is full, so the answer was not saved. Start a new conversation to go on.',
    );
    const shown = j.result.conv.display;
    expect(shown.map((d) => d.kind)).toEqual(['assistant', 'user', 'assistant', 'error']);
    expect(shown[2].text).toBe('Glossed.');
    expect(shown[3].text).toBe('This answer was not saved. This conversation is full.');
  });

  it('gives the reason the save was refused for, whatever it is', async () => {
    await run({ kind: 'assistant', text: 'Glossed.', plan: null, status: null }, serverError);
    expect(notifyError).toHaveBeenCalledWith(
      "The answer was not saved. You don't have permission to do that.",
    );
  });

  it('shows its plan as not saved, with nothing to approve', async () => {
    const { j, data } = await run(
      { kind: 'assistant', text: 'Here is a plan.', plan, status: null },
      tooLarge,
    );
    const shown = j.result.conv.display;
    expect(shown.map((d) => d.kind)).toEqual(['assistant', 'user', 'assistant', 'error']);
    expect(shown[2].text).toBe('Here is a plan.');
    // Not drawn as a plan card, so no Approve over a plan the record lacks.
    expect(shown[2].plan).toBeUndefined();
    expect(shown.some((d) => d.plan?.id === 'p2')).toBe(false);
    expect(shown[3].text).toBe(
      'This answer and its proposed changes were not saved, so the changes cannot be applied. This conversation is full.',
    );
    // The plan before it is still waiting in the record, so it is shown
    // waiting, not replaced by a plan that was never stored.
    expect(shown[0].status).toBe(null);
    expect(shown[0].plan.id).toBe('p1');
    expect(data.get(KEYS.conv).display.some((d) => d.plan?.id === 'p2')).toBe(false);
  });
});
