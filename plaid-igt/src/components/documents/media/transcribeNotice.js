import { t } from '@ui/lib/i18n.js';
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
      title: t('Nothing to transcribe'),
      message: t('No speech found in the recording.'),
    };
  }
  const added = result?.segmentsAdded;
  if (!Number.isInteger(added)) return null;
  const skipped = Number.isInteger(result?.segmentsSkipped) ? result.segmentsSkipped : 0;
  if (added === 0) {
    return {
      level: 'warning',
      title: t('Nothing new to transcribe'),
      message: skipped
        ? t('Every segment heard overlaps one already here.')
        : t('No speech was added to the transcript.'),
    };
  }
  return {
    level: 'success',
    title: t('Transcription complete'),
    message: skipped
      ? t(
          'Added {added, plural, one {# segment} other {# segments}}. Skipped {skipped, plural, one {# segment that overlaps} other {# segments that overlap}} segments already here.',
          { added, skipped },
        )
      : t('Added {added, plural, one {# segment} other {# segments}}.', { added }),
  };
}
