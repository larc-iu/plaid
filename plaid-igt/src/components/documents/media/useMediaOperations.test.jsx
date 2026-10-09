import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mountDocumentHook,
  fakeDocument,
  fakeClient,
  fakeWriteLock,
} from '@/test/mountDocumentHook.jsx';
import { fakeRaf } from '@/test/fakeRaf.js';
import { notifyInfo, notifyWarning } from '@/utils/feedback';
import { useMediaOperations } from './useMediaOperations.js';

vi.mock('@/utils/feedback', async (importOriginal) => ({
  ...(await importOriginal()),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
}));

// The media tab's operations hook, at the seams where it can fall behind the
// document on screen: the media link the <video> streams, and the whole file
// fetched behind it for the waveform and speech detection.
//
// The end state hides everything interesting about them. An answer for a
// recording the tab has already left behind still arrives, and the next thing
// that changes quietly draws the right one over it, so a test that reads only
// what the hook ended on cannot tell a guarded request from an unguarded one.
// What is asserted here is the sequence of `{url, loading, error}` the tab
// actually SHOWED.

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
// One deferred per media link asked for, in order.
let links;
const mediaLink = vi.fn(() => {
  const d = deferred();
  links.push(d);
  return d.promise;
});
// Good for six hours, as the server's are.
const link = (name) => ({
  url: `link:${name}`,
  expiresAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
});
// MediaError codes.
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;

beforeEach(() => {
  fetches = [];
  links = [];
  mediaLink.mockClear();
  localStorage.clear();
  notifyInfo.mockClear();
  notifyWarning.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn((url) => {
      const d = deferred();
      fetches.push({ url, ...d });
      return d.promise;
    }),
  );
  // The fetch failures below are reported, and the report is not the subject.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
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
  const client = opts.client ?? fakeClient({ documents: { mediaLink } });
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

describe('useMediaOperations: the recording', () => {
  it('a link that arrives after the tab closes is never shown, and fetches nothing', async () => {
    const h = await mountMedia();
    expect(links).toHaveLength(1);
    expect(h.seq).toEqual([EMPTY, LOADING]);

    await h.unmount();
    links[0].resolve(link('a'));
    await settle();
    await settle();
    expect(fetches).toHaveLength(0);
    expect(h.seq).toEqual([EMPTY, LOADING]);
  });

  it('the player has its link before the whole file, which is read through the link', async () => {
    const h = await mountMedia();
    expect(fetches).toHaveLength(0);
    await h.step(async () => {
      links[0].resolve(link('a'));
      await settle();
    });
    expect(h.api.authenticatedMediaUrl).toBe('link:a');
    expect(h.api.mediaBlob).toBeNull();
    // Through the link: this page's own session, never a token from storage.
    expect(fetches.map((f) => f.url)).toEqual(['link:a']);

    await h.step(async () => {
      fetches[0].resolve(recording('a'));
      await settle();
    });
    expect(h.api.mediaBlob.name).toBe('a');
    expect(h.api.mediaBlobKey).toBe('/api/v1/documents/doc-1/media?v=a');
    await h.unmount();
  });

  it('leaving stops the whole-file read', async () => {
    const h = await mountMedia();
    await h.step(async () => {
      links[0].resolve(link('a'));
      await settle();
    });
    const { signal } = global.fetch.mock.calls[0][1];
    expect(signal.aborted).toBe(false);
    await h.unmount();
    expect(signal.aborted).toBe(true);
  });

  it('a recording swapped mid-request keeps the new one, whichever answer lands first', async () => {
    const h = await mountMedia();
    await h.setInputs({ doc: withMedia('/api/v1/documents/doc-1/media?v=b') });
    expect(links).toHaveLength(2);

    await h.step(async () => {
      links[1].resolve(link('b'));
      await settle();
    });
    await h.step(async () => {
      fetches[0].resolve(recording('b'));
      await settle();
    });
    expect(h.api.authenticatedMediaUrl).toBe('link:b');

    // The recording the tab left behind answers late.
    await h.step(async () => {
      links[0].resolve(link('a'));
      await settle();
    });

    expect(fetches).toHaveLength(1);
    expect(h.seq).toEqual([EMPTY, LOADING, { url: 'link:b', loading: false, error: null }]);
    expect(h.api.mediaBlob.name).toBe('b');
    await h.unmount();
  });

  it('a refused link says so, and a failure for the recording that was swapped away does not', async () => {
    const failed = await mountMedia();
    await failed.step(async () => {
      links[0].reject(Object.assign(new Error('No media file found'), { status: 404 }));
      await settle();
    });
    expect(failed.seq).toEqual([
      EMPTY,
      LOADING,
      { url: null, loading: false, error: 'Not found.' },
    ]);
    await failed.unmount();

    links.length = 0;
    const h = await mountMedia();
    await h.setInputs({ doc: withMedia('/api/v1/documents/doc-1/media?v=b') });
    await h.step(async () => {
      links[0].reject(new Error('the network went away'));
      await settle();
    });
    // The failure belongs to a recording nobody is looking at any more.
    expect(h.api.mediaLoadError).toBeNull();
    expect(h.api.isLoadingMedia).toBe(true);

    await h.step(async () => {
      links[1].resolve(link('b'));
      await settle();
    });
    expect(h.seq).toEqual([EMPTY, LOADING, { url: 'link:b', loading: false, error: null }]);
    await h.unmount();
  });

  it('a whole file that cannot be read leaves the player alone', async () => {
    const h = await mountMedia();
    await h.step(async () => {
      links[0].resolve(link('a'));
      await settle();
    });
    await h.step(async () => {
      fetches[0].resolve({ ok: false, status: 500 });
      await settle();
    });
    expect(h.seq).toEqual([EMPTY, LOADING, { url: 'link:a', loading: false, error: null }]);
    expect(h.api.mediaBlob).toBeNull();
    await h.unmount();
  });

  it('a link that stops working is asked for again, and playback goes on from where it was', async () => {
    const h = await mountMedia();
    const el = fakeMediaElement([], { currentTime: 0, paused: true });
    await loadRecording(h, el);
    el.currentTime = 42;
    el.paused = false;

    // The element failed to read its link (it expired, say).
    let again;
    await h.step(() => {
      again = h.api.relinkMedia(MEDIA_ERR_NETWORK);
    });
    expect(again).toBe(true);
    expect(links).toHaveLength(2);
    await h.step(async () => {
      links[1].resolve(link('a2'));
      await settle();
    });
    expect(h.api.authenticatedMediaUrl).toBe('link:a2');
    expect(h.api.mediaReady).toBe(false);

    // The new link loads from the start, and is put back where the old one was.
    el.currentTime = 0;
    await h.step(() => h.api.handleMediaLoaded('link:a2'));
    expect(el.currentTime).toBe(42);
    expect(el.play).toHaveBeenCalled();
    expect(h.api.mediaReady).toBe(true);
    await h.unmount();
  });

  it('a file that keeps failing is not asked for again and again', async () => {
    const h = await mountMedia();
    const el = fakeMediaElement([]);
    await loadRecording(h, el);
    // A file that does not decode fails the same way on any link.
    expect(h.api.relinkMedia(MEDIA_ERR_DECODE)).toBe(false);
    expect(links).toHaveLength(1);

    // One new link for a failure that might be the link's...
    await h.step(() => h.api.relinkMedia(MEDIA_ERR_NETWORK));
    await h.step(async () => {
      links[1].resolve(link('a2'));
      await settle();
    });
    await h.step(() => h.api.handleMediaLoaded('link:a2'));
    // ...and not another while that one is good for hours yet, though it
    // loaded: a file that fails at the same place every time would loop.
    expect(h.api.relinkMedia(MEDIA_ERR_NETWORK)).toBe(false);
    expect(links).toHaveLength(2);
    await h.unmount();
  });

  it('a link about to run out is renewed again', async () => {
    const h = await mountMedia();
    const el = fakeMediaElement([]);
    await loadRecording(h, el);
    await h.step(() => h.api.relinkMedia(MEDIA_ERR_NETWORK));
    await h.step(async () => {
      links[1].resolve({ url: 'link:a2', expiresAt: new Date(Date.now() + 1000).toISOString() });
      await settle();
    });
    await h.step(() => h.api.handleMediaLoaded('link:a2'));
    expect(h.api.relinkMedia(MEDIA_ERR_NETWORK)).toBe(true);
    expect(links).toHaveLength(3);
    await h.unmount();
  });

  it('a renewal refused while signed out can be tried again by hand', async () => {
    const h = await mountMedia();
    const el = fakeMediaElement([]);
    await loadRecording(h, el);
    await h.step(() => h.api.relinkMedia(MEDIA_ERR_NETWORK));
    await h.step(async () => {
      links[1].reject(Object.assign(new Error('Token invalid'), { status: 401 }));
      await settle();
    });
    expect(h.api.mediaLoadError).not.toBeNull();

    // Signed back in, the person presses Try again.
    await h.step(() => h.api.retryMedia());
    expect(h.api.mediaLoadError).toBeNull();
    await h.step(async () => {
      links[2].resolve(link('a3'));
      await settle();
    });
    expect(h.api.authenticatedMediaUrl).toBe('link:a3');
    await h.unmount();
  });

  it("an error before this recording's link is handed over is the old recording's", async () => {
    const h = await mountMedia();
    const el = fakeMediaElement([], { currentTime: 30, paused: false });
    await loadRecording(h, el);
    await h.setInputs({ doc: withMedia('/api/v1/documents/doc-1/media?v=b') });
    // The old link is still being read, and fails.
    expect(h.api.relinkMedia(MEDIA_ERR_NETWORK)).toBe(false);
    expect(el.pause).toHaveBeenCalled();
    expect(h.api.currentTime).toBe(0);
    await h.unmount();
  });

  it('a document with no recording asks for nothing and shows nothing', async () => {
    const h = await mountMedia({ doc: withMedia(null) });
    expect(fetches).toHaveLength(0);
    expect(links).toHaveLength(0);
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

// The recording's link, read by the element the tab plays through.
const loadRecording = async (h, el) => {
  await h.step(async () => {
    links[0].resolve(link('a'));
    await settle();
    await settle();
  });
  await h.step(() => h.api.setMediaElement(el));
  await h.step(() => h.api.handleMediaLoaded('link:a'));
};

// The element the tab plays through.
const fakeMediaElement = (refusals, over = {}) => ({
  volume: 0,
  defaultPlaybackRate: 1,
  playbackRate: 1,
  currentTime: 0,
  duration: 10,
  play: refusedPlay(refusals),
  pause: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
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
    await loadRecording(h, el);

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

describe('useMediaOperations: playing one stretch', () => {
  const playing = async (h, el) => {
    await loadRecording(h, el);
    await h.step(() => h.api.handlePlayingChange(true));
    await h.step(() => h.api.playRange({ start: 1, end: 2 }));
  };

  it('stops at the end of the stretch, and loops back to its start when asked', async () => {
    const raf = fakeRaf().install();
    const h = await mountMedia();
    const el = fakeMediaElement([]);
    await playing(h, el);
    expect(el.currentTime).toBe(1);
    expect(raf.pending).toBe(1);

    // Still inside the stretch: nothing happens, and the loop goes on.
    el.currentTime = 1.5;
    await h.step(() => raf.pump());
    expect(el.pause).not.toHaveBeenCalled();
    expect(raf.pending).toBe(1);

    el.currentTime = 2.01;
    await h.step(() => raf.pump());
    expect(el.pause).toHaveBeenCalledTimes(1);
    expect(el.currentTime).toBe(2);
    expect(h.api.playingSelection).toBeNull();
    expect(raf.pending).toBe(0);
    // What the element says of the pause.
    await h.step(() => h.api.handlePlayingChange(false));

    // With looping on, the end of the stretch is its start again.
    await h.step(() => h.api.setLoopSegment(true));
    await h.step(() => h.api.playRange({ start: 1, end: 2 }));
    await h.step(() => h.api.handlePlayingChange(true));
    el.currentTime = 2.01;
    await h.step(() => raf.pump());
    expect(el.pause).toHaveBeenCalledTimes(1);
    expect(el.currentTime).toBe(1);
    expect(raf.pending).toBe(1);

    await h.unmount();
    expect(raf.pending).toBe(0);
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
  it('refuses while another service run is in flight', async () => {
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
    expect(h.container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(doc.saveBaselineText).not.toHaveBeenCalled();
    expect(h.locks.acquire).not.toHaveBeenCalled();
    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    await h.unmount();
  });
});

// A study reads the audit log: a transcription, every write the service
// makes, is one service run naming the service.
describe('useMediaOperations: transcribing in the audit log', () => {
  it('is one service-run operation naming the service', async () => {
    const opts = [];
    const client = fakeClient({
      withOperation: async (_label, fn, o) => {
        opts.push(o);
        return fn();
      },
      messages: { discoverServices: vi.fn(async () => SERVICES) },
    });
    const doc = withMedia('/api/v1/documents/doc-1/media?v=a', { body: '' });
    const h = await mountMedia({ doc, client });
    expect(h.api.transcribeSpot.service?.serviceId).toBe('asr-1');
    await h.step(async () => {
      await h.api.handleTranscribe();
      await settle();
    });
    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    expect(opts).toEqual([{ kind: 'service-run', ref: 'service:asr-1' }]);
    await h.unmount();
  });

  // The client holds one open operation, and an edit still saving holds one.
  // Opened then, the run's operation joined the edit's, and every write the
  // service made was recorded as that edit. The run waits for the edits made before it, then opens its own and
  // hands it to the service.
  it('waits for the edits made before it, so its operation is its own', async () => {
    const saved = deferred();
    const order = [];
    const client = fakeClient({
      withOperation: async (_label, fn) => {
        order.push('operation');
        return fn();
      },
      messages: { discoverServices: vi.fn(async () => SERVICES) },
    });
    const doc = withMedia('/api/v1/documents/doc-1/media?v=a', {
      body: '',
      whenSaved: vi.fn(() => {
        order.push('saving');
        return saved.promise;
      }),
    });
    const h = await mountMedia({ doc, client });
    let done;
    await h.step(async () => {
      done = h.api.handleTranscribe();
      await settle();
    });
    expect(order).toEqual(['saving']);
    expect(client.messages.requestService).not.toHaveBeenCalled();
    await h.step(async () => {
      saved.resolve();
      await done;
      await settle();
    });
    expect(order).toEqual(['saving', 'operation']);
    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    expect(client.messages.requestService.mock.calls[0][6]).toMatchObject({ noOperation: false });
    await h.unmount();
  });
});

describe('useMediaOperations: detecting speech', () => {
  it('refuses a second run rather than opening a progress row for one that never starts', async () => {
    const client = fakeClient({
      messages: {
        discoverServices: vi.fn(async () => SERVICES),
        // A run that is still out there: nothing resolves it.
        requestService: vi.fn(() => new Promise(() => {})),
      },
    });
    const h = await mountMedia({ client });

    await h.step(() => h.api.detectSpot.choose('service:det-1'));
    await h.step(async () => {
      h.api.handleDetectSpeech();
      await settle();
    });
    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    expect(h.api.isProcessing).toBe(true);
    expect(h.api.detectRun.running).toBe(true);
    expect(h.api.vad.status).toBe('running');

    // Asked again while the first is still out. `requestService` refuses and
    // returns nothing, so the dialog used to open a run, see no result, and
    // close it again without a word: the first run's own progress row went
    // with it.
    await h.step(async () => {
      h.api.handleDetectSpeech();
      await settle();
    });

    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    expect(h.api.detectRun.running).toBe(true);
    expect(h.api.vad.status).toBe('running');
    await h.unmount();
  });
});

// The recording is fetched whole and handed to the element after the tab
// opens, and the transcript rows draw before it arrives. A seek or a play made
// on an element with no file yet is lost: the playhead is put back to 0 when
// the file lands, and a pending play is aborted. The transport buttons wait
// for the file (MediaPlayer). The keys, a row's play and a row's play on entry
// go through here, and wait the same way.
describe('useMediaOperations: playing before the recording has loaded', () => {
  const arrive = async (h, name) => {
    await h.step(async () => {
      links[links.length - 1].resolve(link(name));
      await settle();
      await settle();
    });
  };

  const tryEverything = async (h) => {
    await h.step(() => h.api.playRange({ start: 1, end: 2 }));
    await h.step(() => h.api.playRangeFromHere({ start: 3, end: 4 }));
    await h.step(() => h.api.togglePlayback());
    await h.step(() => h.api.seekBy(1));
    await h.step(() => h.api.setSelection({ start: 5, end: 6 }));
    await h.step(async () => {
      press({ code: 'Space', key: ' ' });
      press({ code: 'Space', key: ' ', shiftKey: true });
      press({ code: 'ArrowRight', key: 'ArrowRight', shiftKey: true });
      await settle();
    });
  };

  const untouched = (h, el) => ({
    ready: h.api.mediaReady,
    at: el.currentTime,
    plays: el.play.mock.calls.length,
    shown: h.api.currentTime,
    range: h.api.playingSelection,
  });
  const UNTOUCHED = { ready: false, at: 0, plays: 0, shown: 0, range: null };

  it('moves and plays nothing until the element has the file, then plays', async () => {
    const h = await mountMedia();
    const el = fakeMediaElement([]);
    await h.step(() => h.api.setMediaElement(el));

    // The link is still on its way.
    await tryEverything(h);
    expect(untouched(h, el)).toEqual(UNTOUCHED);

    // Handed to the element, which has not read it yet.
    await arrive(h, 'a');
    expect(h.api.authenticatedMediaUrl).toBe('link:a');
    await tryEverything(h);
    expect(untouched(h, el)).toEqual(UNTOUCHED);

    // The element has read it.
    await h.step(() => h.api.handleMediaLoaded('link:a'));
    expect(h.api.mediaReady).toBe(true);
    await h.step(() => h.api.playRange({ start: 1, end: 2 }));
    expect(el.currentTime).toBe(1);
    expect(el.play).toHaveBeenCalledTimes(1);
    expect(h.api.playingSelection).toEqual({ start: 1, end: 2 });
    await h.step(() => h.api.seekBy(1));
    expect(el.currentTime).toBe(2);
    await h.unmount();
  });

  it('waits again while a new recording loads in place of the old one', async () => {
    const h = await mountMedia();
    const el = fakeMediaElement([]);
    await h.step(() => h.api.setMediaElement(el));
    await arrive(h, 'a');
    await h.step(() => h.api.handleMediaLoaded('link:a'));
    expect(h.api.mediaReady).toBe(true);

    await h.setInputs({ doc: withMedia('/api/v1/documents/doc-1/media?v=b') });
    expect(h.api.mediaReady).toBe(false);
    await arrive(h, 'b');
    // The old file's metadata, reported late, is not the new file's.
    await h.step(() => h.api.handleMediaLoaded('link:a'));
    await tryEverything(h);
    expect(untouched(h, el)).toEqual(UNTOUCHED);

    await h.step(() => h.api.handleMediaLoaded('link:b'));
    expect(h.api.mediaReady).toBe(true);
    await h.unmount();
  });
});

// Stop is offered from the moment the run starts (the dialog and the banner),
// and its first phase has no request for Stop to cancel: the wait for the
// edits made before the run. A Stop pressed there used to do nothing, and the
// run went on to ask the service.
describe('useMediaOperations: stopping a transcription before the service is asked', () => {
  const STOPS = [
    ['the banner', (h) => h.locks.state.held.options.onCancel()],
    ['the dialog', (h) => h.api.stopTranscribe()],
  ];

  it.each(STOPS)(
    'from %s while earlier edits save, it ends and writes nothing',
    async (_where, stop) => {
      const saved = deferred();
      const operations = [];
      const client = fakeClient({
        withOperation: async (label, fn) => {
          operations.push(label);
          return fn();
        },
        messages: { discoverServices: vi.fn(async () => SERVICES) },
      });
      const doc = withMedia('/api/v1/documents/doc-1/media?v=a', {
        body: '',
        whenSaved: vi.fn(() => saved.promise),
      });
      const h = await mountMedia({ doc, client });
      let settled = false;
      await h.step(async () => {
        h.api.handleTranscribe().then(() => {
          settled = true;
        });
        await settle();
      });
      expect(h.api.transcribeRun.running).toBe(true);

      await h.step(async () => {
        await stop(h);
        await settle();
        await settle();
      });
      expect(settled).toBe(true);
      expect(h.api.transcribeRun.running).toBe(false);
      expect(h.locks.state.held).toBeNull();
      expect(operations).toEqual([]);
      expect(client.messages.requestService).not.toHaveBeenCalled();
      expect(doc._reload).not.toHaveBeenCalled();
      expect(notifyInfo).toHaveBeenCalledWith(
        'Stopped. The transcript is unchanged.',
        'Transcribe',
      );

      // The edits landing later start nothing.
      await h.step(async () => {
        saved.resolve();
        await settle();
      });
      expect(client.messages.requestService).not.toHaveBeenCalled();
      await h.unmount();
    },
  );

  // N2-SERVICES-1: the run used to ask "Replace existing transcript?" and
  // clear the whole text before asking the service, so every word, gloss
  // and translation went, and a failed run left the document empty.
  it('on a document with text, asks nothing and clears nothing: the service writes into it', async () => {
    const client = fakeClient({
      messages: { discoverServices: vi.fn(async () => SERVICES) },
    });
    const doc = withMedia('/api/v1/documents/doc-1/media?v=a', {
      body: 'an existing transcript',
      saveBaselineText: vi.fn(async () => true),
    });
    const h = await mountMedia({ doc, client });
    await h.step(async () => {
      await h.api.handleTranscribe();
      await settle();
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(doc.saveBaselineText).not.toHaveBeenCalled();
    expect(client.messages.requestService).toHaveBeenCalledTimes(1);
    await h.unmount();
  });
});

// Someone else deletes or replaces the recording while this page plays it.
// The page learns it when it reads the document again (its next write is
// refused as changed elsewhere, since the recording's change moved the
// document's version), and says so.
describe('useMediaOperations: the recording changed elsewhere', () => {
  const A = '/api/v1/documents/doc-1/media?v=1-4';
  const B = '/api/v1/documents/doc-1/media?v=2-4';

  it('says a recording deleted elsewhere is gone', async () => {
    const h = await mountMedia({ doc: withMedia(A) });
    await h.setInputs({ doc: withMedia(null) });
    expect(notifyWarning).toHaveBeenCalledWith('Deleted elsewhere.', 'Recording deleted');
    await h.unmount();
  });

  it('says a recording replaced elsewhere was replaced', async () => {
    const h = await mountMedia({ doc: withMedia(A) });
    await h.setInputs({ doc: withMedia(B) });
    expect(notifyWarning).toHaveBeenCalledWith('Replaced elsewhere.', 'Recording replaced');
    await h.unmount();
  });

  it('says nothing of a recording that appears, or of another document', async () => {
    const h = await mountMedia({ doc: withMedia(null) });
    await h.setInputs({ doc: withMedia(A) });
    await h.setInputs({ doc: withMedia(null, { document: { id: 'doc-2' } }) });
    expect(notifyWarning).not.toHaveBeenCalled();
    await h.unmount();
  });

  it("says nothing of this page's own delete", async () => {
    const deleting = deferred();
    const doc = withMedia(A, { deleteMedia: vi.fn(() => deleting.promise) });
    const h = await mountMedia({ doc });
    let done;
    await h.step(async () => {
      done = h.api.handleDeleteMedia();
      await settle();
    });
    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find(
      (b) => b.textContent === 'Delete',
    );
    await h.step(async () => {
      confirm.click();
      await settle();
    });
    expect(doc.deleteMedia).toHaveBeenCalled();
    // The delete shows at once, before the server answers.
    await h.setInputs({ doc: withMedia(null, { deleteMedia: doc.deleteMedia }) });
    await h.step(async () => {
      deleting.resolve(true);
      await done;
    });
    expect(notifyWarning).not.toHaveBeenCalled();
    await h.unmount();
  });
});
