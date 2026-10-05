// What a failed recording upload says, in every importer that uploads one.
//
// The server answers 413 to a recording over its media limit. humanizeError's
// 413 is about a document too long to save, which is the wrong advice for a
// recording, so a 413 here names the recording and the limit instead.

import { humanizeError, statusOf } from '@ui/lib/errors.js';
import { formatBytes } from '../utils/formatBytes.js';

export async function mediaUploadFailure(client, err) {
  if (statusOf(err) !== 413) return humanizeError(err);
  let max = null;
  try {
    max = (await client.server.limits())?.mediaFileBytes ?? null;
  } catch {
    // The limit is only for the wording.
  }
  return max
    ? `The recording is over the ${formatBytes(max)} limit.`
    : 'The recording is over the size limit.';
}
