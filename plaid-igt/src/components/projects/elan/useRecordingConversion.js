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
  // {name, fraction, index, total} while a conversion runs, else null.
  const [converting, setConverting] = useState(null);
  const stopRef = useRef(false);

  /** Convert `files` in place, one after another. Failures are reported and skipped. */
  const convertRecordings = async (files) => {
    stopRef.current = false;
    const failed = [];
    for (const [index, file] of files.entries()) {
      if (stopRef.current) break;
      setConverting({ name: file.name, fraction: 0, index, total: files.length });
      try {
        const converted = await transcodeToMp3(file, {
          onProgress: (fraction) => setConverting((c) => (c ? { ...c, fraction } : c)),
        });
        if (converted) {
          setMediaFiles((prev) => prev.map((f) => (f === file ? converted : f)));
        }
      } catch (error) {
        console.error('Converting a recording failed:', error);
        failed.push(file.name);
      }
    }
    setConverting(null);
    if (failed.length) {
      notifyError(
        `${failed.join(', ')} could not be converted. ${failed.length === 1 ? 'It stays' : 'They stay'} as ${failed.length === 1 ? 'it is' : 'they are'}.`,
        'Conversion failed',
      );
    } else if (files.length > 1) {
      notifyWarning(`Converted ${files.length} recordings.`, 'Recordings');
    }
  };

  return { converting, convertRecordings, stopConverting: () => (stopRef.current = true) };
}
