import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mountDocumentHook,
  fakeDocument,
  fakeClient,
  fakeWriteLock,
} from '@/test/mountDocumentHook.jsx';
import { useMediaOperations } from './useMediaOperations.js';

// The media tab's operations hook, at the one seam where it can fall behind
// the document on screen: the authenticated fetch that turns the recording
// into a blob the <video> can play.
//
// The end state hides everything interesting about it. A response for a
// recording the tab has already left behind still arrives, and the next thing
// that changes quietly draws the right one over it, so a test that reads only
// what the hook ended on cannot tell a guarded fetch from an unguarded one.
// What is asserted here is the sequence of `{url, loading, error}` the tab
// actually SHOWED, plus what was done with the object URLs, which is where an
// unguarded response leaves its other mark: one that is created and never
// revoked, pinning the whole download for the life of the tab.

const settle = () => new Promise((r) => setTimeout(r, 0));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// A response carrying a recording named for the test that asked for it, so
// the object URL says which fetch it came from.
const recording = (name) => ({
  ok: true,
  status: 200,
  blob: async () => ({ size: name.length, name }),
});

let fetches;
let created;
let revoked;
let realCreateObjectURL;
let realRevokeObjectURL;

beforeEach(() => {
  fetches = [];
  created = [];
  revoked = [];
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn((url) => {
      const d = deferred();
      fetches.push({ url, ...d });
      return d.promise;
    }),
  );
  realCreateObjectURL = URL.createObjectURL;
  realRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn((blob) => {
    const url = `blob:${blob.name}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url) => revoked.push(url));
  // The fetch failures below are reported, and the report is not the subject.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// What the tab shows about the recording, recorded on every commit.
const track = (api) => ({
  url: api.authenticatedMediaUrl,
  loading: api.isLoadingMedia,
  error: api.mediaLoadError,
});

const withMedia = (mediaUrl, over = {}) =>
  fakeDocument({ ...over, document: { id: 'doc-1', mediaUrl, ...(over.document ?? {}) } });

const mountMedia = async (opts = {}) => {
  const doc = opts.doc ?? withMedia('/api/v1/documents/doc-1/media?v=a');
  const client = opts.client ?? fakeClient();
  const locks = opts.locks ?? fakeWriteLock();
  doc.client = client;
  const h = await mountDocumentHook(useMediaOperations, {
    doc,
    ctx: { client, acquireWriteLock: locks.acquire, canWrite: true },
    track,
    ...opts.extra,
  });
  return Object.assign(h, { doc, client, locks });
};

const EMPTY = { url: null, loading: false, error: null };
const LOADING = { url: null, loading: true, error: null };

describe('useMediaOperations: fetching the recording', () => {
  it('a response that arrives after the tab closes is never turned into a URL', async () => {
    const h = await mountMedia();
    expect(fetches).toHaveLength(1);
    expect(h.seq).toEqual([EMPTY, LOADING]);

    await h.unmount();
    fetches[0].resolve(recording('a'));
    await settle();
    await settle();

    // Nothing was created, so there is nothing left pinned: an unguarded
    // response would create an object URL after the cleanup that revokes it.
    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
    expect(h.seq).toEqual([EMPTY, LOADING]);
  });

  it('a recording swapped mid-fetch keeps the new one, whichever response lands first', async () => {
    const h = await mountMedia();
    await h.setInputs({ doc: withMedia('/api/v1/documents/doc-1/media?v=b') });
    expect(fetches.map((f) => f.url)).toEqual([
      '/api/v1/documents/doc-1/media?v=a',
      '/api/v1/documents/doc-1/media?v=b',
    ]);

    await h.step(async () => {
      fetches[1].resolve(recording('b'));
      await settle();
    });
    expect(h.api.authenticatedMediaUrl).toBe('blob:b');

    // The recording the tab left behind answers late.
    await h.step(async () => {
      fetches[0].resolve(recording('a'));
      await settle();
    });

    expect(h.seq).toEqual([EMPTY, LOADING, { url: 'blob:b', loading: false, error: null }]);
    expect(created).toEqual(['blob:b']);
    expect(h.api.mediaBlob.name).toBe('b');

    await h.unmount();
    expect(revoked).toEqual(['blob:b']);
  });

  it('a failed fetch says so, and a failure for the recording that was swapped away does not', async () => {
    const failed = await mountMedia();
    await failed.step(async () => {
      fetches[0].resolve({ ok: false, status: 404 });
      await settle();
    });
    expect(failed.seq).toEqual([
      EMPTY,
      LOADING,
      { url: null, loading: false, error: 'server responded 404' },
    ]);
    await failed.unmount();

    fetches.length = 0;
    const h = await mountMedia();
    await h.setInputs({ doc: withMedia('/api/v1/documents/doc-1/media?v=b') });
    await h.step(async () => {
      fetches[0].reject(new Error('the network went away'));
      await settle();
    });
    // The failure belongs to a recording nobody is looking at any more.
    expect(h.api.mediaLoadError).toBeNull();
    expect(h.api.isLoadingMedia).toBe(true);

    await h.step(async () => {
      fetches[1].resolve(recording('b'));
      await settle();
    });
    expect(h.seq).toEqual([EMPTY, LOADING, { url: 'blob:b', loading: false, error: null }]);
    await h.unmount();
  });

  it('a document with no recording fetches nothing and shows nothing', async () => {
    const h = await mountMedia({ doc: withMedia(null) });
    expect(fetches).toHaveLength(0);
    expect(h.seq).toEqual([EMPTY]);
    await h.unmount();
  });
});

// `play()` refused the way a browser refuses it when its autoplay policy has
// not been satisfied. The refusal is recorded rather than thrown into the
// environment: what matters is whether the caller attached a handler to it,
// and an unhandled rejection is something every runner reports differently.
const refusedPlay = (refusals) =>
  vi.fn(() => {
    const record = { handled: false };
    refusals.push(record);
    const error = new Error('play() was refused');
    return {
      catch(onRejected) {
        record.handled = true;
        return Promise.resolve().then(() => onRejected(error));
      },
      then(_onFulfilled, onRejected) {
        if (!onRejected) return Promise.resolve();
        record.handled = true;
        return Promise.resolve().then(() => onRejected(error));
      },
    };
  });

// The element the tab plays through.
const fakeMediaElement = (refusals, over = {}) => ({
  volume: 0,
  defaultPlaybackRate: 1,
  playbackRate: 1,
  currentTime: 0,
  duration: 10,
  play: refusedPlay(refusals),
  pause: vi.fn(),
  ...over,
});

const press = (init) =>
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
  );

describe('useMediaOperations: the playback keys', () => {
  it('a refused play is swallowed, whichever key started it', async () => {
    const h = await mountMedia();
    const refusals = [];
    const el = fakeMediaElement(refusals);
    await h.step(() => h.api.setMediaElement(el));

    // Space plays from the playhead.
    await h.step(async () => {
      press({ code: 'Space', key: ' ' });
      await settle();
    });
    // Shift+Space plays the selected stretch on from where it stopped.
    await h.step(() => h.api.setSelection({ start: 1, end: 4 }));
    await h.step(async () => {
      press({ code: 'Space', key: ' ', shiftKey: true });
      await settle();
    });

    expect(el.play).toHaveBeenCalledTimes(2);
    expect(refusals.map((r) => r.handled)).toEqual([true, true]);
    await h.unmount();
  });
});

const SERVICES = [
  { serviceId: 'asr-1', serviceName: 'Whisper', online: true, extras: { tasks: ['transcribe'] } },
  {
    serviceId: 'det-1',
    serviceName: 'Detector',
    online: true,
    extras: { tasks: ['detect-speech'] },
  },
];

describe('useMediaOperations: transcribing', () => {
  it('refuses while another service run is in flight, before the transcript is cleared', async () => {
    const client = fakeClient({
      messages: {
        discoverServices: vi.fn(async () => SERVICES),
        // A run that is still out there: nothing resolves it.
        requestService: vi.fn(() => new Promise(() => {})),
      },
    });
    const doc = withMedia('/api/v1/documents/doc-1/media?v=a', { body: 'an existing transcript' });
    const h = await mountMedia({ doc, client });

    // Speech detection by a SERVICE, which takes no write lock.
    await h.step(() => h.api.detectSpot.choose('service:det-1'));
    expect(h.api.detectSpot.service?.serviceId).toBe('det-1');
    await h.step(async () => {
      h.api.handleDetectSpeech();
      await settle();
    });
    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    expect(h.api.isProcessing).toBe(true);
    expect(h.api.transcribeSpot.service?.serviceId).toBe('asr-1');

    let settled = false;
    await h.step(async () => {
      h.api.handleTranscribe().then(() => {
        settled = true;
      });
      await settle();
    });

    expect(settled).toBe(true);
    // Not even asked: the answer to "Replace existing transcript?" would have
    // been acted on by a run that could not start.
    expect(h.container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(doc.saveBaselineText).not.toHaveBeenCalled();
    expect(h.locks.acquire).not.toHaveBeenCalled();
    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    await h.unmount();
  });
});
