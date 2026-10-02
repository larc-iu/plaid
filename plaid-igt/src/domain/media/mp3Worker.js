// MP3 encoding, off the main thread.
//
// LAME in plain JavaScript (~60 kB gzipped, no wasm and so no cross-origin
// isolation to arrange), fed the mono 16 kHz samples the decoder already
// produces for speech detection. An hour of audio takes tens of seconds of
// solid CPU, which is exactly the kind of work that must not run on the thread
// painting the page.

import { encodeMp3 } from './mp3Encode.js';

// A stop terminates the worker: the encode reads no message until it ends.
self.onmessage = ({ data }) => {
  if (data.type !== 'run') return;
  try {
    const mp3 = encodeMp3(data.samples, data.sampleRate, data.bitrateKbps, (done, total) =>
      self.postMessage({ type: 'progress', done, total }),
    );
    self.postMessage({ type: 'result', mp3 }, [mp3.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message ?? String(error) });
  }
};
