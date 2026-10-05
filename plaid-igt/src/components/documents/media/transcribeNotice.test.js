import { describe, expect, it } from 'vitest';
import { transcribeNotice } from './transcribeNotice.js';

describe('transcribeNotice', () => {
  it('says nothing new was transcribed when every segment overlapped one already here', () => {
    expect(transcribeNotice({ segmentsAdded: 0, segmentsSkipped: 2 })).toEqual({
      level: 'warning',
      title: 'Nothing new to transcribe',
      message: 'Every segment heard overlaps one already here.',
    });
  });

  it('counts what was added, and what was skipped', () => {
    expect(transcribeNotice({ segmentsAdded: 1, segmentsSkipped: 0 }).message).toBe(
      'Added 1 segment.',
    );
    expect(transcribeNotice({ segmentsAdded: 3, segmentsSkipped: 1 })).toEqual({
      level: 'success',
      title: 'Transcription complete',
      message: 'Added 3 segments. Skipped 1 segment that overlaps segments already here.',
    });
  });

  it('leaves a service that reports no counts to the fixed copy', () => {
    expect(transcribeNotice({ tokensCreated: 2 })).toBeNull();
    expect(transcribeNotice(null)).toBeNull();
  });
});
