import { describe, it, expect, beforeEach } from 'vitest';
import { writeRunRecord, readRunRecord, clearRunRecord } from './runRecord.js';

// The pointer a reloaded page follows back to a run that is still going.

describe('runRecord', () => {
  beforeEach(() => localStorage.clear());

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
      multiStep: false,
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

  it('marks a browser-ordered run, so a resume can say the rest did not run', () => {
    writeRunRecord('doc-1', {
      requestId: 'req-1',
      projectId: 'p',
      label: 'Auto-analyze',
      multiStep: true,
    });
    expect(readRunRecord('doc-1').multiStep).toBe(true);
  });

  it('writes nothing without an id to point at', () => {
    writeRunRecord('doc-1', { projectId: 'p', label: 'Tokenize' });
    expect(readRunRecord('doc-1')).toBe(null);
  });

  it('treats a malformed or half-written record as no record', () => {
    localStorage.setItem('plaid_igt_run_doc-1', 'not json');
    expect(readRunRecord('doc-1')).toBe(null);
    // An id with no project cannot be attached to.
    localStorage.setItem('plaid_igt_run_doc-2', JSON.stringify({ requestId: 'req-1' }));
    expect(readRunRecord('doc-2')).toBe(null);
  });
});
