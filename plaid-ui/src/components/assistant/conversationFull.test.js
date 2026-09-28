import { describe, it, expect, vi } from 'vitest';

// A conversation at the server's size limit refused the reader's next message
// (413), and the turn was requested anyway. The service reads the message from
// the record, so it answered a conversation that did not contain it.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { notifyError } = await import('../../lib/notify.js');
const { compactPlan, settle, startTurn } = await import('./jobs.js');
const { planRows } = await import('./planChanges.js');

const tooLarge = Object.assign(new Error('Value exceeds 1000000 bytes'), { status: 413 });

describe('a message the record refused', () => {
  it('is not sent, and comes back as the unsent text', async () => {
    const saved = { messages: [], display: [{ kind: 'user', text: 'earlier' }] };
    const requestService = vi.fn();
    const store = {
      client: {
        messages: { requestService },
        userData: {
          put: vi.fn(async () => {
            throw tooLarge;
          }),
          get: vi.fn(async (_u, key) => (key.includes(':conv:') ? { value: saved } : null)),
        },
      },
      userId: 'u1',
      app: 'igt',
      projectId: 'p1',
    };
    const conv = {
      id: 'c-full',
      messages: [{ role: 'user', content: 'plan it' }],
      display: [...saved.display, { kind: 'user', text: 'plan it' }],
    };
    const j = startTurn({ store, service: { serviceId: 's' }, conv, prevMeta: null });
    const { conv: after } = await j.promise;
    expect(requestService).not.toHaveBeenCalled();
    expect(j.unsent).toBe('plan it');
    expect(after.display.at(-1).text).toBe('earlier');
    expect(notifyError).toHaveBeenCalledWith(expect.stringContaining('This conversation is full'));
  });
});

describe('a settled plan', () => {
  const plan = {
    id: 'p1',
    summary: '2 field values',
    labels: ['a', 'b'],
    changes: [{ label: 'a' }, { label: 'b' }],
    ops: [{ kind: 'x' }, { kind: 'y' }],
    documents: [{ id: 'd1', version: 3 }],
  };

  it('drops what only approving it needed, and the card rows stay the same', () => {
    const done = compactPlan({ kind: 'assistant', plan, status: 'discarded' });
    expect(done.plan).not.toHaveProperty('ops');
    expect(done.plan).not.toHaveProperty('documents');
    expect(done.plan.opCount).toBe(2);
    expect(planRows(done.plan)).toEqual(planRows(plan));
  });

  it('is compacted when discarded here, and an undecided one is left whole', () => {
    const conv = {
      messages: [],
      display: [
        { kind: 'assistant', plan, status: null },
        { kind: 'assistant', plan: { ...plan, id: 'p2' }, status: null },
      ],
    };
    const out = settle(conv, 0, 'discarded', '(note) discarded');
    expect(out.display[0].plan.opCount).toBe(2);
    expect(out.display[1].plan.ops).toHaveLength(2);
  });
});
