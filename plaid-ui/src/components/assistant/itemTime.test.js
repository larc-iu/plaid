import { describe, it, expect, vi } from 'vitest';

// Every conversation item carries when it was written (`createdAt`), so a
// reader of the record can date each turn. The service stamps the replies and
// errors it writes, and the browser the items it writes itself: the question,
// and the error or stop it records when the service never wrote one.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { startTurn } = await import('./jobs.js');
const { itemTime } = await import('./itemTime.js');

const ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

// A record held in memory, read back as written.
const memoryStore = (requestService) => {
  const values = new Map();
  return {
    client: {
      messages: { requestService },
      userData: {
        put: vi.fn(async (_u, key, value) => {
          values.set(key, value);
        }),
        get: vi.fn(async (_u, key) => (values.has(key) ? { value: values.get(key) } : null)),
      },
    },
    userId: 'u1',
    app: 'igt',
    projectId: 'p1',
  };
};

const asked = (id) => ({
  id,
  messages: [{ role: 'user', content: 'gloss it' }],
  display: [{ kind: 'user', text: 'gloss it', createdAt: itemTime() }],
});

describe('an item the browser writes', () => {
  it('is dated as the service dates its own', () => {
    expect(itemTime(new Date(Date.UTC(2026, 9, 6, 1, 2, 3, 4)))).toBe('2026-10-06T01:02:03.004Z');
    expect(itemTime()).toMatch(ISO_MS);
  });

  it('records a turn the service never answered as an error with its time', async () => {
    const failed = Object.assign(new Error('boom'), { status: 500 });
    const store = memoryStore(
      vi.fn(async () => {
        throw failed;
      }),
    );
    const before = Date.now();
    const j = startTurn({
      store,
      service: { serviceId: 's' },
      conv: asked('c-fail'),
      prevMeta: null,
    });
    const { conv } = await j.promise;
    const err = conv.display.at(-1);
    expect(err.kind).toBe('error');
    expect(err.createdAt).toMatch(ISO_MS);
    expect(Date.parse(err.createdAt)).toBeGreaterThanOrEqual(before - 1);
    expect(conv.display[0].createdAt).toMatch(ISO_MS);
  });

  it('records a stopped turn with its time', async () => {
    const stopped = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const store = memoryStore(
      vi.fn(async () => {
        throw stopped;
      }),
    );
    const j = startTurn({
      store,
      service: { serviceId: 's' },
      conv: asked('c-stop'),
      prevMeta: null,
    });
    const { conv } = await j.promise;
    const err = conv.display.at(-1);
    expect(err).toMatchObject({ kind: 'error', stopped: true });
    expect(err.createdAt).toMatch(ISO_MS);
  });
});
