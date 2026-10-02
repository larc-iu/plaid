import { describe, it, expect, vi, beforeEach } from 'vitest';

const toast = { error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock('sonner', () => ({ toast }));

const {
  reportIntegrityFindings,
  formatFindingsForClipboard,
  dismissIntegrityFindings,
  INTEGRITY_DESCRIPTION,
} = await import('./integrityToast.js');

const finding = (severity, code, message, context = {}) => ({ severity, code, message, context });

beforeEach(() => {
  toast.error.mockClear();
  toast.warning.mockClear();
  toast.info.mockClear();
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
    // The finding is a developer's sentence: the toast says one generic line.
    expect(options.description).toBe(INTEGRITY_DESCRIPTION);
    expect(options.duration).toBe(Infinity);
  });

  it('says the same generic line for several findings', () => {
    reportIntegrityFindings([finding('warning', 'w1', 'a'), finding('warning', 'w2', 'b')]);
    expect(toast.warning.mock.calls[0][1].description).toBe(INTEGRITY_DESCRIPTION);
  });

  it('replaces its own notice rather than stacking them', () => {
    reportIntegrityFindings([finding('warning', 'w', 'a')]);
    reportIntegrityFindings([finding('warning', 'w', 'a')]);
    const ids = toast.warning.mock.calls.map(([, o]) => o.id);
    expect(new Set(ids).size).toBe(1);
    dismissIntegrityFindings();
    expect(toast.dismiss).toHaveBeenCalledWith(ids[0]);
  });

  // REV-FX-CORE F5: a rule the stored data keeps out is a standing fact the
  // editor already holds, not damage, so it is said once, plainly, and goes.
  it('says a rule not in force plainly, not as damage, and lets it go', () => {
    const rule = finding(
      'warning',
      'layer-rules-not-in-force',
      'The acyclic rules of "UMR relations" are not in force: 3 stored relations break them.',
    );
    reportIntegrityFindings([rule], { documentId: 'd1' });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    const [title, options] = toast.info.mock.calls[0];
    expect(title).toBe('Layer rules not in force');
    expect(options.description).toBe(rule.message);
    expect(options.duration).not.toBe(Infinity);
    expect(options.action).toBeUndefined();
  });

  it('keeps the integrity notice for the other findings beside a rule not in force', () => {
    reportIntegrityFindings([
      finding('warning', 'layer-rules-not-in-force', 'a'),
      finding('error', 'span-duplicate', 'b'),
    ]);
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0][1].description).toBe(INTEGRITY_DESCRIPTION);
    expect(toast.error.mock.calls[0][1].action.label).toBe('Copy details');
  });
});
