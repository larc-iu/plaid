// Converting the recordings of a batch before it is imported.
//
// Deliberately BEFORE, not during: the size that comes out is the fact the
// user is deciding on, and an import that converted as it went would only
// report it once the run was already committed. It also keeps the engine as it
// was, since what it uploads is simply the file it is handed.
//
// The converted file replaces the original in the batch's media list, and
// matchMediaFiles pairs it with the same .eaf: an .eaf names its recording,
// and `oni-lifestory-ah-c.mp3` is still the recording `oni-lifestory-ah-c.mp4`
// names.

import { useRef, useState } from 'react';
import { notifyError, notifyWarning } from '@/utils/feedback';
import { transcodeToMp3 } from '@/domain/media/transcodeToMp3';

export function useRecordingConversion(setMediaFiles) {
  // {name, fraction, index, total, stopping} while a conversion runs, else null.
  const [converting, setConverting] = useState(null);
  const abortRef = useRef(null);

  /**
   * Convert `files` in place, one after another. Failures are reported and
   * skipped. A stop ends the file being converted (its original stays in the
   * batch) and the ones after it, and keeps the ones already converted.
   */
  const convertRecordings = async (files) => {
    const controller = new AbortController();
    abortRef.current = controller;
    const failed = [];
    let done = 0;
    for (const [index, file] of files.entries()) {
      if (controller.signal.aborted) break;
      setConverting({ name: file.name, fraction: 0, index, total: files.length, stopping: false });
      try {
        const converted = await transcodeToMp3(file, {
          signal: controller.signal,
          onProgress: (fraction) => setConverting((c) => (c ? { ...c, fraction } : c)),
        });
        if (converted) {
          setMediaFiles((prev) => prev.map((f) => (f === file ? converted : f)));
          done += 1;
        }
      } catch (error) {
        console.error('Converting a recording failed:', error);
        failed.push(file.name);
      }
    }
    if (abortRef.current === controller) abortRef.current = null;
    setConverting(null);
    if (failed.length) {
      notifyError(
        `${failed.join(', ')} ${failed.length === 1 ? 'is' : 'are'} unchanged.`,
        'Failed to convert',
      );
    } else if (controller.signal.aborted) {
      notifyWarning(`Converted ${done} of ${files.length}.`, 'Conversion stopped');
    } else if (files.length > 1) {
      notifyWarning(`Converted ${files.length} recordings.`, 'Recordings');
    }
  };

  // A recording is decoded whole before it is encoded, and the decode cannot
  // be interrupted, so the stop is said at once and lands when it ends.
  const stopConverting = () => {
    if (!abortRef.current) return;
    abortRef.current.abort();
    setConverting((c) => (c ? { ...c, stopping: true } : c));
  };

  return { converting, convertRecordings, stopConverting };
}
