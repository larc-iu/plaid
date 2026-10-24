import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { renderComponent } from '../test/renderComponent.jsx';

// The check itself is the document's, so `doc.validateOnOpen` is the seam.
// What is under test is when it runs and what it tells the person.
vi.mock('../lib/integrityToast.js', () => ({ reportIntegrityFindings: vi.fn() }));

const { reportIntegrityFindings } = await import('../lib/integrityToast.js');
const { useValidateOnOpen } = await import('./useValidateOnOpen.js');

let view;

const Probe = (props) => {
  useValidateOnOpen(props);
  return null;
};

const makeDoc = (result = { findings: [] }, asOf = null, id = 'doc-1') => ({
  id,
  asOf,
  validateOnOpen: vi.fn(() => result),
});

const base = { asOf: null, canWrite: true };

beforeEach(() => {
  reportIntegrityFindings.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('useValidateOnOpen', () => {
  it("reports what the document's check finds, naming the document", async () => {
    const findings = [{ severity: 'error', code: 'x' }];
    const doc = makeDoc({ findings });
    view = await renderComponent(<Probe {...base} doc={doc} />);
    expect(doc.validateOnOpen).toHaveBeenCalledTimes(1);
    expect(reportIntegrityFindings).toHaveBeenCalledWith(findings, { documentId: 'doc-1' });
    await view.unmount();
  });

  it('checks once per document, not once per render or per StrictMode setup', async () => {
    const doc = makeDoc();
    view = await renderComponent(
      <StrictMode>
        <Probe {...base} doc={doc} />
      </StrictMode>,
    );
    await view.rerender(
      <StrictMode>
        <Probe {...base} doc={doc} />
      </StrictMode>,
    );
    expect(doc.validateOnOpen).toHaveBeenCalledTimes(1);
    const next = makeDoc({ findings: [] }, null, 'doc-2');
    await view.rerender(
      <StrictMode>
        <Probe {...base} doc={next} />
      </StrictMode>,
    );
    expect(next.validateOnOpen).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('does not check for a reader who cannot edit, or over a past state', async () => {
    const reader = makeDoc();
    view = await renderComponent(<Probe {...base} doc={reader} canWrite={false} />);
    await view.unmount();
    const viewed = makeDoc();
    view = await renderComponent(<Probe {...base} doc={viewed} asOf="2026-09-01T00:00:00Z" />);
    await view.unmount();
    const snapshot = makeDoc({ findings: [] }, '2026-09-01T00:00:00Z');
    view = await renderComponent(<Probe {...base} doc={snapshot} />);
    await view.unmount();
    for (const doc of [reader, viewed, snapshot]) expect(doc.validateOnOpen).not.toHaveBeenCalled();
    expect(reportIntegrityFindings).not.toHaveBeenCalled();
  });

  it('enters strict mode on every path, before the page edits', async () => {
    const enterStrictMode = vi.fn();
    view = await renderComponent(
      <Probe {...base} doc={makeDoc()} canWrite={false} enterStrictMode={enterStrictMode} />,
    );
    expect(enterStrictMode).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('logs a check that failed and reports what it found', async () => {
    const error = new Error('boom');
    view = await renderComponent(<Probe {...base} doc={makeDoc({ findings: [], error })} />);
    expect(console.error).toHaveBeenCalledWith('Checking the document failed:', error);
    expect(reportIntegrityFindings).toHaveBeenCalledWith([], { documentId: 'doc-1' });
    await view.unmount();
  });
});
