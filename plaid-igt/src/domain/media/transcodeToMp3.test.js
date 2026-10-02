import { describe, it, expect, vi, afterEach } from 'vitest';
import { transcodeToMp3 } from './transcodeToMp3.js';

// A stop has to end a conversion in the middle of its encode. The worker's
// encode is one synchronous loop, and a worker reads no message while a
// handler runs, so a stop posted to it would be read only once the file was
// done (R1 of the review of R2-DEBT-APPS-24). This Worker behaves that way:
// what is posted during the encode waits until the encode ends, and only
// terminate() cuts it short.

vi.mock('../vad/decodeTo16kMono.js', () => ({
  TARGET_RATE: 16000,
  decodeTo16kMono: async () => new Float32Array(16000),
}));

let finishEncode;
const workers = [];
class SingleTaskWorker {
  constructor() {
    this.inbox = [];
    this.busy = false;
    this.terminated = false;
    workers.push(this);
  }
  postMessage(data) {
    if (this.busy) {
      this.inbox.push(data); // read after the task, never during it
      return;
    }
    if (data.type !== 'run') return;
    this.busy = true;
    finishEncode = () => {
      this.busy = false;
      if (this.terminated) return;
      this.onmessage?.({ data: { type: 'result', mp3: new Uint8Array([1, 2, 3]) } });
    };
  }
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  workers.length = 0;
});

describe('transcodeToMp3 stopped mid-encode', () => {
  it('answers null at once and ends the worker', async () => {
    vi.stubGlobal('Worker', SingleTaskWorker);
    const controller = new AbortController();
    const result = transcodeToMp3(new File(['x'], 'long.wav'), { signal: controller.signal });
    await vi.waitFor(() => expect(workers[0]?.busy).toBe(true));
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(workers[0].terminated).toBe(true);
    // The encode ending later changes nothing.
    finishEncode();
  });

  it('converts when nobody stops it', async () => {
    vi.stubGlobal('Worker', SingleTaskWorker);
    const result = transcodeToMp3(new File(['x'], 'long.wav'));
    await vi.waitFor(() => expect(workers[0]?.busy).toBe(true));
    finishEncode();
    const file = await result;
    expect(file.name).toBe('long.mp3');
    expect(file.size).toBe(3);
  });
});
