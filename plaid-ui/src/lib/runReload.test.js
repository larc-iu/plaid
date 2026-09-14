import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
}));

const notify = await import('./notify.js');
const { reloadAfterRun } = await import('./runReload.js');

// The failure this covers is a silent one: the service wrote, the success toast
// has been shown, and the re-read of the document throws. Every caller had that
// throw land in the same catch as the request's own, which said nothing at all
// or called the run a failure, and the screen went on showing pre-run data.

beforeEach(() => {
  for (const fn of Object.values(notify)) fn.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('re-reading a document after a run', () => {
  it('says nothing when it comes back', async () => {
    expect(await reloadAfterRun(async () => {})).toBe(true);
    expect(notify.notifyWarning).not.toHaveBeenCalled();
    expect(notify.notifyError).not.toHaveBeenCalled();
  });

  it('says what is on screen is stale when it does not', async () => {
    const ok = await reloadAfterRun(async () => {
      throw new Error('HTTP 500 boom at http://localhost:8085/api/v1/documents/d1');
    });
    expect(ok).toBe(false);
    expect(notify.notifyWarning).toHaveBeenCalledWith(
      'The run finished but the document could not be reloaded. Reload the page to see it.',
      'Results not shown',
    );
  });

  it('does not call the run a failure', async () => {
    await reloadAfterRun(async () => {
      throw new Error('nope');
    });
    expect(notify.notifyError).not.toHaveBeenCalled();
    const [message, title] = notify.notifyWarning.mock.calls[0];
    expect(`${title} ${message}`).not.toMatch(/fail/i);
  });

  it('swallows nothing: the throw does not escape to the caller', async () => {
    await expect(reloadAfterRun(() => Promise.reject(new Error('nope')))).resolves.toBe(false);
  });
});
