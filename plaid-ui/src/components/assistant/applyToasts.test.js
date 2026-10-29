import { describe, it, expect, vi, beforeEach } from 'vitest';

// The toaster is bottom-right in all three apps, which is exactly where the
// docked panel's composer is. A success toast there covered the message the
// user was about to type, to repeat what the plan card beside it already says
// in green. Only the success one is dropped: a hard failure leaves the card
// undecided with no inline explanation, so its toast is the only place the
// reason ever appears.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  notifyInfo: vi.fn(),
  dismissToast: vi.fn(),
}));

const { notifySuccess, notifyError, notifyWarning, notifyInfo, dismissToast } = await import(
  '../../lib/notify.js'
);
const { applyToasts, settleApplyToasts } = await import('./jobs.js');

const applied = { outcome: { message: 'Applied 2 changes.' } };

describe('applyToasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says so on the full tab, where nothing is covered', () => {
    applyToasts(applied, '2 changes');
    expect(notifySuccess).toHaveBeenCalledTimes(1);
  });

  it('is titled Nothing written when the approval wrote nothing', () => {
    const msg = 'The settings were already in force. Nothing was written.';
    applyToasts({ outcome: { kind: 'applied', applied: 0, counts: [], message: msg } }, '1 change');
    expect(notifySuccess).not.toHaveBeenCalled();
    expect(notifyInfo).toHaveBeenCalledWith(msg, 'Nothing written');
    vi.clearAllMocks();
    applyToasts(
      { outcome: { kind: 'applied', applied: 0, counts: [], message: msg } },
      '1 change',
      {
        docked: true,
      },
    );
    expect(notifyInfo).not.toHaveBeenCalled();
  });

  it('stays quiet in the docked panel, where the card says it', () => {
    applyToasts(applied, '2 changes', { docked: true });
    expect(notifySuccess).not.toHaveBeenCalled();
  });

  it('still reports a failure in the docked panel', () => {
    applyToasts({ error: { status: 500, message: 'boom' } }, 'x', { docked: true });
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0][1]).toBe('Not applied');
  });

  it('keeps a refusal on screen until it is closed', () => {
    const said = 'Nothing was written. "-et" is locked by another run. Try again in a minute.';
    applyToasts({ error: { status: 400, message: said } }, 'x');
    expect(notifyError.mock.calls[0][1]).toBe('Not applied');
    expect(notifyError.mock.calls[0][2]).toEqual({ duration: Infinity });
  });

  it('still reports lost contact in the docked panel', () => {
    applyToasts({ error: { pending: true } }, 'x', { docked: true });
    expect(notifyWarning).toHaveBeenCalledTimes(1);
  });

  it('says nothing for a duplicate application, docked or not', () => {
    applyToasts({ outcome: { duplicate: true } }, 'x');
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});

// conc-2026-09-29 H8-4: after "Out of date" the editor kept showing the old
// sentence, since only an apply that succeeded reloaded it.
describe('changesTheView', () => {
  it('reloads the host after every finished apply but one still running', async () => {
    const { changesTheView } = await import('./jobs.js');
    const apply = (extra) => ({ done: true, kind: 'apply', ...extra });
    expect(changesTheView(apply({ outcome: { message: 'Applied.' } }))).toBe(true);
    expect(changesTheView(apply({ error: { message: 'Nothing was written. Out of date.' } }))).toBe(
      true,
    );
    expect(changesTheView(apply({ error: { message: 'Stopped partway.' } }))).toBe(true);
    expect(changesTheView(apply({ error: { message: 'lost', pending: true } }))).toBe(false);
    expect(changesTheView({ done: true, kind: 'turn' })).toBe(false);
    expect(changesTheView({ done: false, kind: 'apply' })).toBe(false);
  });
});

describe('a plan that stopped partway', () => {
  beforeEach(() => vi.clearAllMocks());
  it('is a warning titled Partly applied, docked or not', async () => {
    const { applyToasts } = await import('./jobs.js');
    const j = { outcome: { partial: true, message: 'Partly applied: 1 of 3 changes written.' } };
    applyToasts(j, 'x', { docked: true });
    expect(notifyWarning).toHaveBeenCalledWith(
      'Partly applied: 1 of 3 changes written.',
      'Partly applied',
    );
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});

// FX20-APPROVE: an approval whose assistant died left "Not applied / Service
// disconnected" on screen after the card had settled how the approval ended.
// A dead run settles Partly applied (R53).
describe('the Not applied toast once the card settles', () => {
  beforeEach(() => vi.clearAllMocks());
  const plan = { id: 'p1', summary: 'x' };
  const dead = { status: 503, message: 'Service disconnected' };
  const job = (item) => ({ planId: 'p1', error: dead, conv: { display: [item] } });

  it('is dismissed when the record settles the plan Partly applied, then not again', () => {
    applyToasts(job({ plan, status: null }), 'x', { docked: true });
    const id = notifyError.mock.calls[0][2].id;
    expect(id).toBeTruthy();
    settleApplyToasts([{ plan, status: null }]);
    expect(dismissToast).not.toHaveBeenCalled();
    settleApplyToasts([{ plan, status: 'partial', written: [] }]);
    expect(dismissToast).toHaveBeenCalledWith(id);
    settleApplyToasts([{ plan, status: 'applied' }]);
    expect(dismissToast).toHaveBeenCalledTimes(1);
  });

  it('is dismissed when the plan settles Applied', () => {
    applyToasts(job({ plan, status: null }), 'x');
    settleApplyToasts([{ plan, status: 'applied' }]);
    expect(dismissToast).toHaveBeenCalledWith(notifyError.mock.calls[0][2].id);
  });
});
