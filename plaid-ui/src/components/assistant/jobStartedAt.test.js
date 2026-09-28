import { describe, it, expect, vi, afterEach } from 'vitest';

// The turn's clock counts from the job's `startedAt`. A turn rejoined after a
// reload used to start its clock again at 0:00, because the clock began when
// the screen noticed the turn rather than when the request was made.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { attachJob } = await import('./jobs.js');

const never = () => new Promise(() => {});
const store = (overrides = {}) => ({
  client: {
    messages: { attachServiceRequest: vi.fn(never), cancelServiceRequest: vi.fn() },
    userData: { get: vi.fn(), put: vi.fn() },
    ...overrides,
  },
  userId: 'u1',
  app: 'umr',
  projectId: 'p1',
});
const conv = (id) => ({ id, messages: [], display: [] });

describe('a rejoined job', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the time its request was made', () => {
    const j = attachJob({
      store: store(),
      conv: conv('c-kept'),
      meta: {
        id: 'c-kept',
        pending: { kind: 'turn', requestId: 'r1', startedAt: '2026-09-28T10:00:00.000Z' },
      },
    });
    expect(j.startedAt).toBe(Date.parse('2026-09-28T10:00:00.000Z'));
    j.controller.abort();
  });

  it('starts now when the record carries no time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
    const j = attachJob({
      store: store(),
      conv: conv('c-none'),
      meta: { id: 'c-none', pending: { kind: 'turn', requestId: 'r2' } },
    });
    expect(j.startedAt).toBe(Date.parse('2026-09-28T12:00:00.000Z'));
    j.controller.abort();
  });
});
