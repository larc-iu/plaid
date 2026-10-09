import { describe, it, expect, vi, afterEach } from 'vitest';
import { LEASE_MS, announce, closedHere, heldElsewhere } from './hold.js';

// One tab acts on a conversation at a time (Luke's ruling, 2026-10-09). The
// service decides with its own clock; the page reads the hold the same way,
// against the server's time, to show a conversation read-only or take it.

const at = (ms) => new Date(ms).toISOString();

describe('heldElsewhere', () => {
  const now = Date.parse('2026-10-09T12:00:00.000Z');

  it('is a hold by another tab whose lease has not run out', () => {
    expect(heldElsewhere({ tab: 'b', at: at(now - 60_000) }, 'a', now)).toBe(true);
    expect(heldElsewhere({ tab: 'b', at: at(now - LEASE_MS + 1000) }, 'a', now)).toBe(true);
  });

  it('is not a hold of this tab, nobody holding it, or a lease run out', () => {
    expect(heldElsewhere({ tab: 'a', at: at(now) }, 'a', now)).toBe(false);
    expect(heldElsewhere(null, 'a', now)).toBe(false);
    expect(heldElsewhere({ tab: 'b', at: at(now - LEASE_MS - 1000) }, 'a', now)).toBe(false);
  });

  it('is five minutes long, as the service keeps it', () => {
    expect(LEASE_MS).toBe(5 * 60 * 1000);
  });
});

describe('closedHere', () => {
  const real = globalThis.navigator?.locks;
  afterEach(() => {
    Object.defineProperty(globalThis.navigator, 'locks', { value: real, configurable: true });
    window.localStorage.removeItem('plaid-assistant-tabs');
  });

  const locks = (held) => ({
    query: vi.fn(async () => ({ held: held.map((name) => ({ name })) })),
    request: vi.fn(() => new Promise(() => {})),
  });

  it('is a tab of this browser whose lock is free', async () => {
    window.localStorage.setItem('plaid-assistant-tabs', JSON.stringify(['gone-tab', 'live-tab']));
    Object.defineProperty(globalThis.navigator, 'locks', {
      value: locks(['plaid-assistant-tab:live-tab']),
      configurable: true,
    });
    expect(await closedHere('gone-tab')).toBe(true);
    expect(await closedHere('live-tab')).toBe(false);
  });

  it('is not a tab some other browser or device minted, which the lease decides', async () => {
    window.localStorage.setItem('plaid-assistant-tabs', JSON.stringify(['mine']));
    Object.defineProperty(globalThis.navigator, 'locks', { value: locks([]), configurable: true });
    expect(await closedHere('elsewhere')).toBe(false);
  });

  it('is not known without Web Locks', async () => {
    window.localStorage.setItem('plaid-assistant-tabs', JSON.stringify(['gone-tab']));
    Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
    expect(await closedHere('gone-tab')).toBe(false);
  });
});

describe('announce', () => {
  it('tells the other tabs of this browser which conversation this one took', () => {
    const posted = [];
    const Real = globalThis.BroadcastChannel;
    globalThis.BroadcastChannel = class {
      constructor(name) {
        this.name = name;
      }
      postMessage(m) {
        posted.push([this.name, m]);
      }
      close() {}
    };
    try {
      announce('c1');
    } finally {
      globalThis.BroadcastChannel = Real;
    }
    expect(posted).toHaveLength(1);
    expect(posted[0][0]).toBe('plaid-assistant');
    expect(posted[0][1].conv).toBe('c1');
    expect(posted[0][1].tab).toBeTruthy();
  });
});
