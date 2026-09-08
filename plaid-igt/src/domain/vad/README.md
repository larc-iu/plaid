# Speech detection

Voice activity detection in the browser, for the Media tab's first pass at
segmentation. Nothing here talks to a server, and a recording never leaves the
page.

## What is vendored

`silero_vad_16k.onnx` is Silero VAD (MIT), taken from the `silero-vad` PyPI
package version 6.2.1, file `silero_vad/data/silero_vad_16k_op15.onnx`. It is
the 16 kHz-only export, 1.29 MB against 2.33 MB for the dual-rate
`silero_vad.onnx`, and it was checked to produce bit-identical probabilities on
real speech, which is why the smaller one is here.

Praat drives the same model in `Sound: To TextGrid (speech activity, Silero)...`,
so a first pass here and a first pass there agree.

## Layout

- `decodeTo16kMono.js` gets the recording into mono 16 kHz float samples.
- `vadWorker.js` runs the model, one 512-sample frame at a time with 64 samples
  of context, off the main thread. It loads ONNX Runtime and the model on first
  use, so nothing is fetched until somebody presses Detect.
- `speechProbabilities.js` owns the worker and gives back per-frame
  probabilities. They do not depend on any tuning parameter, which is why they
  are cached and only the step below re-runs when a slider moves.
- `speechTimestamps.js` turns probabilities into segment boundaries. It is a
  port of `get_speech_timestamps` from silero-vad's `utils_vad.py`, and staying
  faithful to it is the requirement, not a preference.

The proposals themselves live in
`components/documents/media/useVadProposals.js`, never on the server.

## Regenerating the test fixture

`speechTimestamps.fixture.json` is recorded from the Python original, so a
failing test means this port drifted. To rebuild it, run silero-vad's own
`get_speech_timestamps` against a model stub that replays a recorded
probability array (so the fixture exercises the post-processing alone), under
each parameter set in the file, and write out the probabilities rounded to 4 dp
together with the boundaries Python produced.
