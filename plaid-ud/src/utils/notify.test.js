import { describe, it, expect, vi } from 'vitest';

// This app's toasts are its own module: the domain layer imports them and the
// node suite loads that directly, where there is no alias to follow. So they
// have to draw what the package's draw, name for name.

const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() });
vi.mock('sonner', () => ({ toast }));

const ud = await import('./notify.js');
const pkg = await import('@ui/lib/notify.js');

const reset = () => {
  toast.mockClear();
  toast.error.mockClear();
  toast.success.mockClear();
  toast.warning.mockClear();
};

// What sonner was asked to draw by one call.
const drawn = (fn, ...args) => {
  reset();
  fn(...args);
  return {
    plain: [...toast.mock.calls],
    success: [...toast.success.mock.calls],
    error: [...toast.error.mock.calls],
    warning: [...toast.warning.mock.calls],
  };
};

describe("this app's toasts and the package's", () => {
  for (const name of ['notifySuccess', 'notifyError', 'notifyWarning', 'notifyInfo']) {
    it(`${name} draws the same toast in both`, () => {
      expect(typeof ud[name]).toBe('function');
      const args = ['HTTP 423 Locked at http://localhost:8085/api/v1/spans', 'Save'];
      expect(drawn(ud[name], ...args)).toEqual(drawn(pkg[name], ...args));
    });
  }

  it('is the message itself when there is no title', () => {
    reset();
    ud.notifyInfo('Run stopped.');
    expect(toast).toHaveBeenCalledWith('Run stopped.', {});
  });
});
