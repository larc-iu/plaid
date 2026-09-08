// Turning a recording that is too large to upload into one that is not.
//
// A 41-minute video can be half a gigabyte, and the server takes 200 MB. For
// what the Media tab is for — hearing the words and placing them in time — the
// picture and the fidelity are both surplus: the same recording as mono 16 kHz
// MP3 is about 8 MB an hour, and its timeline is identical, so segments and
// alignments made against it still line up with the original.
//
// It is NOT phonetic-grade, and offering it must say so. This is the choice
// between a recording you cannot upload and one you can.
//
// Decoding is `decodeTo16kMono`, the same function speech detection uses: it
// hands the file to the browser's own decoders, so whatever the Media tab can
// play, this can convert. That also means the whole file passes through
// memory, which is the real limit here. Streaming would mean demuxing the
// container ourselves (WebCodecs decodes but does not demux) and is a much
// larger piece of work for a path taken once per recording.

import { decodeTo16kMono, TARGET_RATE } from '../vad/decodeTo16kMono.js';

/** Mono speech at 16 kHz. Enough for transcription, small enough to send. */
export const MP3_BITRATE_KBPS = 32;

/**
 * Big enough that sending audio alone is worth offering even when the server
 * would accept the file as it is. A judgement about the user's time and
 * connection, not about what the server allows.
 */
export const OFFER_CONVERSION_OVER = 50 * 1000 * 1000;

/**
 * What to do about a recording of `bytes`, given the server's limit (null when
 * it has not said):
 *   'required' — it would be refused, so converting is the only way through
 *   'offer'    — it would be accepted, but is large enough to ask about
 *   null       — send it
 */
export const conversionNeed = (bytes, maxBytes) => {
  if (maxBytes != null && bytes > maxBytes) return 'required';
  return bytes > OFFER_CONVERSION_OVER ? 'offer' : null;
};

/** What `file` would become, so a caller can say so before starting. */
export const mp3NameFor = (name) => {
  const stem = String(name || '').replace(/\.[^./\\]*$/, '');
  return `${stem || 'audio'}.mp3`;
};

/** Roughly how large the result will be, from the recording's duration. */
export const estimateMp3Bytes = (seconds) => Math.round((seconds * MP3_BITRATE_KBPS * 1000) / 8);

/**
 * Convert any playable recording to a mono 16 kHz MP3.
 *
 * @param {File|Blob} file
 * @param {(fraction: number) => void} [onProgress]  0..1 over the encode
 * @param {AbortSignal} [signal]
 * @returns {Promise<File|null>} null when cancelled
 */
export async function transcodeToMp3(file, { onProgress, signal } = {}) {
  const samples = await decodeTo16kMono(file);
  if (signal?.aborted) return null;

  const worker = new Worker(new URL('./mp3Worker.js', import.meta.url), { type: 'module' });
  try {
    const mp3 = await new Promise((resolve, reject) => {
      const abort = () => worker.postMessage({ type: 'cancel' });
      signal?.addEventListener('abort', abort, { once: true });

      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') onProgress?.(data.total ? data.done / data.total : 0);
        else if (data.type === 'result') resolve(data.mp3);
        else if (data.type === 'cancelled') resolve(null);
        else if (data.type === 'error') reject(new Error(data.message));
      };
      worker.onerror = (event) => reject(new Error(event.message || 'Converting the file failed.'));

      // Transferred, not copied: an hour of samples is 230 MB.
      worker.postMessage(
        { type: 'run', samples, sampleRate: TARGET_RATE, bitrateKbps: MP3_BITRATE_KBPS },
        [samples.buffer],
      );
    });

    if (!mp3) return null;
    return new File([mp3], mp3NameFor(file.name), { type: 'audio/mpeg' });
  } finally {
    worker.terminate();
  }
}
