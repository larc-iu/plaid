// Chosen recordings, readied for upload with the outcome on screen: each one
// refused says so by name, and what was converted says so in one line.
// Every place a person chooses a recording goes through here (the Media tab,
// the ELAN and FLEx importers), so they all say the same thing.

import { convertedNote, prepareRecordings } from '@/domain/media/playableRecording';
import { notifyError, notifyInfo } from '@/utils/feedback';

/** The files to stage, converted ones in place and refused ones left out. */
export async function readyRecordings(files, options) {
  const { files: ready, converted, refused } = await prepareRecordings(files, options);
  for (const message of refused) notifyError(message);
  const note = convertedNote(converted);
  if (note) notifyInfo(note);
  return ready;
}
