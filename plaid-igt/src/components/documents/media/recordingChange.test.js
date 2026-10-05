import { describe, it, expect } from 'vitest';
import { recordingChangeNotice } from './recordingChange.js';

describe('recordingChangeNotice', () => {
  const A = '/api/v1/documents/d/media?v=1-4';
  const B = '/api/v1/documents/d/media?v=2-4';
  it('names a delete and a replacement made elsewhere', () => {
    expect(recordingChangeNotice(A, null)).toEqual({
      title: 'Recording deleted',
      message: 'Deleted elsewhere.',
    });
    expect(recordingChangeNotice(A, B)).toEqual({
      title: 'Recording replaced',
      message: 'Replaced elsewhere.',
    });
  });
  it('says nothing of no change, a recording that appears, or the page own delete', () => {
    expect(recordingChangeNotice(A, A)).toBeNull();
    expect(recordingChangeNotice(null, A)).toBeNull();
    expect(recordingChangeNotice(A, null, { ownDelete: true })).toBeNull();
  });
  it('says what a write refused for the change left unsaved', () => {
    expect(recordingChangeNotice(A, B, { notSaved: 'Segment' })).toEqual({
      title: 'Recording replaced',
      message: 'Replaced elsewhere. Segment not saved.',
    });
    expect(recordingChangeNotice(A, null, { notSaved: 'Segment times' })).toEqual({
      title: 'Recording deleted',
      message: 'Deleted elsewhere. Segment times not saved.',
    });
  });
});
