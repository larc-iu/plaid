import { describe, it, expect, vi, beforeEach } from 'vitest';

const toast = { error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() };
vi.mock('sonner', () => ({ toast }));

const { reportIntegrityFindings, formatFindingsForClipboard, dismissIntegrityFindings } =
  await import('./integrityToast.js');

const finding = (severity, code, message, context = {}) => ({ severity, code, message, context });

beforeEach(() => {
  toast.error.mockClear();
  toast.warning.mockClear();
  toast.dismiss.mockClear();
  vi.spyOn(console, 'group').mockImplementation(() => {});
  vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('formatFindingsForClipboard', () => {
  it('renders one line per finding with the document id header', () => {
    const text = formatFindingsForClipboard(
      [finding('error', 'span-duplicate', 'two spans', { tokens: ['t1'] })],
      { documentId: 'doc-1' },
    );
    expect(text).toContain('doc-1');
    expect(text).toContain('[error] span-duplicate: two spans');
    expect(text).toContain('"tokens":["t1"]');
  });
});

describe('reportIntegrityFindings', () => {
  it('says nothing when the document came back whole', () => {
    reportIntegrityFindings([], { documentId: 'd1' });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reads as an error when any finding is one', () => {
    reportIntegrityFindings([finding('warning', 'w', 'a'), finding('error', 'e', 'b')], {
      documentId: 'd1',
    });
    expect(toast.warning).not.toHaveBeenCalled();
    const [title, options] = toast.error.mock.calls[0];
    expect(title).toBe('Data integrity issue detected');
    // One error among them, so it speaks for the batch rather than being
    // counted alongside the warning.
    expect(options.description).toBe('b');
    expect(options.duration).toBe(Infinity);
  });

  it('counts them when there is more than one to name', () => {
    reportIntegrityFindings([finding('warning', 'w1', 'a'), finding('warning', 'w2', 'b')]);
    expect(toast.warning.mock.calls[0][1].description).toMatch(/^2 issues found/);
  });

  it('replaces its own notice rather than stacking them', () => {
    reportIntegrityFindings([finding('warning', 'w', 'a')]);
    reportIntegrityFindings([finding('warning', 'w', 'a')]);
    const ids = toast.warning.mock.calls.map(([, o]) => o.id);
    expect(new Set(ids).size).toBe(1);
    dismissIntegrityFindings();
    expect(toast.dismiss).toHaveBeenCalledWith(ids[0]);
  });
});
