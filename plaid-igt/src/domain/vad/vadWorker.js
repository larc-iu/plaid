// The Silero frame loop, off the main thread.
//
// Everything expensive lives here: the ONNX Runtime wasm binary (~3.4 MB
// gzipped) and the model (~1.1 MB gzipped) are fetched when this worker is
// first constructed, and never before, so a session that does not press
// Detect pays nothing. Both are served from our own origin, so a recording
// never leaves the browser.
//
// The model is a 128-unit LSTM over 512-sample frames, which makes the loop
// strictly sequential: no batching, and the state of frame i feeds frame i+1.
// It returns raw per-frame probabilities and nothing else. Turning those into
// segments is speechTimestamps.js, on the main thread, because it is instant
// and the Media tab re-runs it on every parameter change.

import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import modelUrl from './silero_vad_16k.onnx?url';

// Threads would need the page to be cross-origin isolated (COOP/COEP), which
// this app is not and should not become for one feature. ORT runs the same
// wasm single-threaded when told to.
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.logLevel = 'error';

const WINDOW = 512;
// The model wants the tail of the previous frame in front of the current one,
// so each call sees 576 samples. Matching silero-vad's own OnnxWrapper here is
// what keeps our probabilities identical to Praat's and to the Python tool.
const CONTEXT = 64;
const PROGRESS_EVERY = 256;

let sessionPromise = null;
const getSession = () => {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }
  return sessionPromise;
};

let cancelled = false;

async function run(samples) {
  const session = await getSession();
  const frames = Math.ceil(samples.length / WINDOW);
  const probs = new Float32Array(frames);

  // One buffer, one tensor: `input` is re-read from this array every run, so
  // there is nothing to reallocate per frame.
  const buffer = new Float32Array(CONTEXT + WINDOW);
  const input = new ort.Tensor('float32', buffer, [1, CONTEXT + WINDOW]);
  const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);

  for (let f = 0; f < frames; f++) {
    if (cancelled) return null;
    const from = f * WINDOW;
    const chunk = samples.subarray(from, Math.min(from + WINDOW, samples.length));
    buffer.set(chunk, CONTEXT);
    // A short final frame is zero-padded, as upstream does.
    if (chunk.length < WINDOW) buffer.fill(0, CONTEXT + chunk.length);

    const out = await session.run({ input, state, sr });
    probs[f] = out.output.data[0];
    state = out.stateN;

    // The next call's context is this call's last 64 samples.
    buffer.copyWithin(0, WINDOW, CONTEXT + WINDOW);

    if (f % PROGRESS_EVERY === 0) {
      self.postMessage({ type: 'progress', done: f, total: frames });
    }
  }
  return probs;
}

self.onmessage = async (event) => {
  const { type, samples } = event.data;
  if (type === 'cancel') {
    cancelled = true;
    return;
  }
  if (type !== 'run') return;
  cancelled = false;
  try {
    const probs = await run(samples);
    if (probs) self.postMessage({ type: 'result', probs }, [probs.buffer]);
    else self.postMessage({ type: 'cancelled' });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message ?? String(error) });
  }
};
