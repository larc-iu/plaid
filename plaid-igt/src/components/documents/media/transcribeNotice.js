// What a finished Transcribe says, from the counts the service reports
// (`segmentsAdded`, `segmentsSkipped`). A run that added nothing, every
// segment it heard overlapping one already here (a second press, say), says
// so instead of "Transcription complete" (REV-N5-APPS R6). A service that
// reports no counts gets the fixed copy (null).
export function transcribeNotice(result) {
  const added = result?.segmentsAdded;
  if (!Number.isInteger(added)) return null;
  const skipped = Number.isInteger(result?.segmentsSkipped) ? result.segmentsSkipped : 0;
  const segments = (n) => `${n} segment${n === 1 ? '' : 's'}`;
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
