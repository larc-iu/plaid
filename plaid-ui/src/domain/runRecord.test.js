import { describe, it, expect, beforeEach } from 'vitest';
import {
  writeRunRecord,
  readRunRecord,
  clearRunRecord,
  __resetUnloadingForTests,
} from './runRecord.js';

// The pointer a reloaded page follows back to a run that is still going.

describe('runRecord', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetUnloadingForTests();
  });

  it('has nothing to say about a document with no run', () => {
    expect(readRunRecord('doc-1')).toBe(null);
    expect(readRunRecord(null)).toBe(null);
  });

  it('round-trips a run, and forgets it on clear', () => {
    writeRunRecord('doc-1', { requestId: 'req-1', projectId: 'proj-1', label: 'Transcribe' });
    const rec = readRunRecord('doc-1');
    expect(rec).toMatchObject({
      requestId: 'req-1',
      projectId: 'proj-1',
      label: 'Transcribe',
      stepsAfter: [],
    });
    expect(rec.startedAt).toBeTypeOf('number');

    clearRunRecord('doc-1');
    expect(readRunRecord('doc-1')).toBe(null);
  });

  it('keeps one run per document', () => {
    writeRunRecord('doc-1', { requestId: 'req-1', projectId: 'p', label: 'Tokenize' });
    writeRunRecord('doc-2', { requestId: 'req-2', projectId: 'p', label: 'Transcribe' });
    expect(readRunRecord('doc-1').requestId).toBe('req-1');
    expect(readRunRecord('doc-2').requestId).toBe('req-2');

    clearRunRecord('doc-1');
    expect(readRunRecord('doc-2').requestId).toBe('req-2');
  });

  it("names the steps after a browser-ordered run's step, so a resume can say they did not run", () => {
    writeRunRecord('doc-1', {
      requestId: 'req-1',
      projectId: 'p',
      label: 'Auto-analyze',
      stepsAfter: ['Copy previous analyses', 'Link to the lexicon'],
    });
    expect(readRunRecord('doc-1').stepsAfter).toEqual([
      'Copy previous analyses',
      'Link to the lexicon',
    ]);
  });

  // Closing or reloading the tab asks first while a run holds the document,
  // and a page whose person said Stay is not going away: the run it finishes
  // is collected, and a record left behind would announce it again, as if its
  // later steps had not run.
  it('is cleared after a leave question the person answered with Stay', () => {
    writeRunRecord('doc-1', { requestId: 'req-1', projectId: 'p', label: 'Auto-analyze' });
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    clearRunRecord('doc-1');
    expect(readRunRecord('doc-1')).toBe(null);
  });

  it('is kept by a page that is going away', () => {
    writeRunRecord('doc-1', { requestId: 'req-1', projectId: 'p', label: 'Auto-analyze' });
    window.dispatchEvent(new Event('pagehide'));
    clearRunRecord('doc-1');
    expect(readRunRecord('doc-1')).not.toBe(null);
  });

  // REV-RUN-3: Auto-analyze left during a built-in step has no request to
  // rejoin, and the page that comes back still says what did not run.
  it('keeps a record with nothing to rejoin, which names the steps that did not run', () => {
    writeRunRecord('doc-1', { projectId: 'p', label: 'Auto-analyze', stepsAfter: ['Link'] });
    expect(readRunRecord('doc-1')).toMatchObject({
      requestId: null,
      label: 'Auto-analyze',
      stepsAfter: ['Link'],
    });
  });

  it('treats a malformed or half-written record as no record', () => {
    localStorage.setItem('plaid_igt_run_doc-1', 'not json');
    expect(readRunRecord('doc-1')).toBe(null);
    // An id with no project cannot be attached to.
    localStorage.setItem('plaid_igt_run_doc-2', JSON.stringify({ requestId: 'req-1' }));
    expect(readRunRecord('doc-2')).toBe(null);
  });

  it('keeps the record when the PAGE is going away, not the run', () => {
    // Tearing the page down kills the request's stream, and the client settles
    // the promise as though the run had ended, so the run's own cleanup fires
    // on the way out. If that were allowed through, the reloaded page would
    // find nothing and the run would vanish from the UI while the service
    // carried on writing — which is exactly what happened before this guard.
    writeRunRecord('doc-1', { requestId: 'req-1', projectId: 'p', label: 'Transcribe' });
    window.dispatchEvent(new Event('pagehide'));

    clearRunRecord('doc-1');
    expect(readRunRecord('doc-1')?.requestId).toBe('req-1');
  });

  it('clears again on a page that came back from the bfcache', () => {
    // `pagehide` fires on the way into the back/forward cache too, and that
    // page can come back; the flag must not stick for the rest of its life.
    writeRunRecord('doc-1', { requestId: 'req-1', projectId: 'p', label: 'Tokenize' });
    window.dispatchEvent(new Event('pagehide'));
    clearRunRecord('doc-1');
    expect(readRunRecord('doc-1')).not.toBe(null);

    window.dispatchEvent(new Event('pageshow'));
    clearRunRecord('doc-1');
    expect(readRunRecord('doc-1')).toBe(null);
  });
});
