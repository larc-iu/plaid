import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Issue #65: a turn that ends while the page is hidden is signalled with a
// system notification (when allowed), a chime and a mark in the tab's title,
// so nobody has to go back and check. Only a turn this page sent, never one
// rejoined on open, and never one the person stopped.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  notifyInfo: vi.fn(),
  dismissToast: vi.fn(),
}));

const { startTurn, attachJob, stopJob, jobs } = await import('./jobs.js');
const { primeTurnSignals, signalTurnEnded, TITLE_MARK } = await import('./turnSignal.js');

let hidden = false;
let shown = [];
let tones = 0;
let permission = 'granted';
let asked = 0;

class FakeNotification {
  static get permission() {
    return permission;
  }
  static requestPermission() {
    asked++;
    return Promise.resolve(permission);
  }
  constructor(title, opts) {
    this.title = title;
    this.body = opts.body;
    this.tag = opts.tag;
    this.close = vi.fn();
    shown.push(this);
  }
}

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => {});
  createOscillator() {
    tones++;
    return { frequency: {}, connect() {}, start() {}, stop() {} };
  }
  createGain() {
    const param = {
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {},
    };
    return { gain: param, connect() {} };
  }
}

const setHidden = (h) => {
  hidden = h;
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  hidden = false;
  shown = [];
  tones = 0;
  permission = 'granted';
  asked = 0;
  jobs.clear();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  document.title = 'Story 1 | Plaid IGT';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.hidden;
});

const KEYS = { meta: 'igt:assistant:p1:meta:c1', conv: 'igt:assistant:p1:conv:c1' };

// A client whose assistant answers each send with `outcome` (or throws
// `error`), and whose record reads back titled.
const setup = ({ outcome = { kind: 'turn' }, error = null, wait = null } = {}) => {
  const records = new Map([
    [KEYS.meta, { id: 'c1', title: 'Glossing chapter 2', pending: null }],
    [KEYS.conv, { messages: [], display: [{ kind: 'user', text: 'hi' }] }],
  ]);
  const client = {
    messages: {
      requestService: vi.fn(async () => {
        if (wait) await wait;
        if (error) throw error;
        return outcome;
      }),
      attachServiceRequest: vi.fn(async () => outcome),
      cancelServiceRequest: vi.fn(async () => {}),
    },
    userData: {
      get: vi.fn(async (_u, key) => ({ value: structuredClone(records.get(key)) })),
    },
  };
  return { client, store: { client, userId: 'u1', app: 'igt', projectId: 'p1' } };
};
const conv = { id: 'c1', messages: [], display: [{ kind: 'user', text: 'hi' }] };
const service = { serviceId: 'igt:assist:one' };

const send = (t) => startTurn({ store: t.store, service, conv, text: 'hi', tab: 'tab-1' });

describe('a turn this page sent', () => {
  it('signals a finish while the page is hidden: notification, chime, title mark', async () => {
    const t = setup();
    hidden = true;
    const j = send(t);
    j.reveal = vi.fn();
    await j.promise;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: 'Glossing chapter 2', body: 'Finished', tag: 'c1' });
    expect(tones).toBeGreaterThan(0);
    expect(document.title).toBe(`${TITLE_MARK}Story 1 | Plaid IGT`);
    // Clicking it focuses the window and shows the conversation.
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    shown[0].onclick();
    expect(focus).toHaveBeenCalled();
    expect(j.reveal).toHaveBeenCalled();
    expect(shown[0].close).toHaveBeenCalled();
    // Seen again: the mark goes.
    setHidden(false);
    expect(document.title).toBe('Story 1 | Plaid IGT');
  });

  it('says nothing while the page is visible', async () => {
    const t = setup();
    await send(t).promise;
    expect(shown).toHaveLength(0);
    expect(tones).toBe(0);
    expect(document.title).toBe('Story 1 | Plaid IGT');
  });

  it('says Failed for a turn that failed', async () => {
    const t = setup({ error: Object.assign(new Error('boom'), { status: 500 }) });
    hidden = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(t).promise;
    expect(shown.map((n) => n.body)).toEqual(['Failed']);
  });

  it('says Stopped for a turn the server stopped', async () => {
    const t = setup({ outcome: { kind: 'stopped' } });
    hidden = true;
    await send(t).promise;
    expect(shown.map((n) => n.body)).toEqual(['Stopped']);
  });

  it('says nothing for a turn the person stopped', async () => {
    let release;
    const t = setup({ outcome: { kind: 'stopped' }, wait: new Promise((r) => (release = r)) });
    const j = send(t);
    await stopJob(t.client, 'p1', j);
    hidden = true;
    release();
    await j.promise;
    expect(shown).toHaveLength(0);
    expect(tones).toBe(0);
  });

  it('says nothing for one still running that the page lost contact with', async () => {
    const t = setup({ error: Object.assign(new Error('lost'), { pending: true }) });
    hidden = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(t).promise;
    expect(shown).toHaveLength(0);
  });

  it('chimes and marks the title without a notification when permission was denied', async () => {
    permission = 'denied';
    const t = setup();
    hidden = true;
    await send(t).promise;
    expect(shown).toHaveLength(0);
    expect(tones).toBeGreaterThan(0);
    expect(document.title.startsWith(TITLE_MARK)).toBe(true);
  });
});

describe('a turn rejoined on open', () => {
  it('is not signalled when it ends', async () => {
    const t = setup();
    hidden = true;
    const j = attachJob({
      store: t.store,
      conv,
      meta: { id: 'c1', pending: { kind: 'turn', requestId: 'r1' } },
      tab: 'tab-1',
    });
    await j.promise;
    expect(shown).toHaveLength(0);
    expect(tones).toBe(0);
  });
});

describe('primeTurnSignals', () => {
  it('asks for permission only while the browser has not been told', () => {
    permission = 'default';
    primeTurnSignals();
    expect(asked).toBe(1);
    permission = 'denied';
    primeTurnSignals();
    expect(asked).toBe(1);
  });
});

describe('signalTurnEnded', () => {
  it('marks the title once however many turns end', () => {
    hidden = true;
    signalTurnEnded({ title: 'A', body: 'Finished', tag: 'a' });
    signalTurnEnded({ title: 'B', body: 'Finished', tag: 'b' });
    expect(document.title).toBe(`${TITLE_MARK}Story 1 | Plaid IGT`);
  });

  it('names the assistant when the conversation has no title', () => {
    hidden = true;
    signalTurnEnded({ title: null, body: 'Finished', tag: 'a' });
    expect(shown[0].title).toBe('Assistant');
  });
});
