import { countOf } from '@ui/lib/plural.js';
// What a finished Transcribe says, from the counts the service reports
// (`segmentsAdded`, `segmentsSkipped`). A run that added nothing, every
// segment it heard overlapping one already here (a second press, say), says
// so instead of "Transcription complete" (REV-N5-APPS R6), and a recording
// with no speech in it (`reason: 'no-speech'`, R23) says that. A service that
// reports no counts gets the fixed copy (null).
export function transcribeNotice(result) {
  if (result?.reason === 'no-speech') {
    return {
      level: 'warning',
      title: 'Nothing to transcribe',
      message: 'No speech found in the recording.',
    };
  }
  const added = result?.segmentsAdded;
  if (!Number.isInteger(added)) return null;
  const skipped = Number.isInteger(result?.segmentsSkipped) ? result.segmentsSkipped : 0;
  const segments = (n) => countOf(n, 'segment');
  if (added === 0) {
    return {
      level: 'warning',
      title: 'Nothing new to transcribe',
      message: skipped
        ? 'Every segment heard overlaps one already here.'
        : 'No speech was added to the transcript.',
    };
  }
  return {
    level: 'success',
    title: 'Transcription complete',
    message:
      `Added ${segments(added)}.` +
      (skipped
        ? ` Skipped ${segments(skipped)} that overlap${skipped === 1 ? 's' : ''} segments already here.`
        : ''),
  };
}
