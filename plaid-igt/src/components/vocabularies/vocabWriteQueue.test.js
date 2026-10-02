import { describe, it, expect, vi } from 'vitest';
import { queuesStatus } from './vocabWriteQueue.js';

// A queue as SaveStatus reads it: saving, retrying, and a listener set.
const fakeQueue = () => {
  const listeners = new Set();
  return {
    isSaving: false,
    isOffline: false,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(state) {
      Object.assign(this, state);
      listeners.forEach((fn) => fn());
    },
    listeners,
  };
};

describe('queuesStatus', () => {
  it('is retrying while either queue retries a send of its own', () => {
    const schema = fakeQueue();
    const entries = fakeQueue();
    const status = queuesStatus(schema, entries);
    expect([status.isSaving, status.isOffline]).toEqual([false, false]);
    entries.set({ isSaving: true });
    expect([status.isSaving, status.isOffline]).toEqual([true, false]);
    entries.set({ isOffline: true });
    expect([status.isSaving, status.isOffline]).toEqual([true, true]);
    // An idle queue's stale offline flag is not a retry.
    entries.set({ isSaving: false });
    schema.set({ isSaving: true });
    expect([status.isSaving, status.isOffline]).toEqual([true, false]);
  });

  it('tells its listener of a change in either queue, and its snapshot changes with it', () => {
    const schema = fakeQueue();
    const entries = fakeQueue();
    const status = queuesStatus(schema, entries);
    const fn = vi.fn();
    const off = status.subscribe(fn);
    const before = status.getSnapshot();
    schema.set({ isSaving: true, isOffline: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(status.getSnapshot()).not.toBe(before);
    off();
    expect(schema.listeners.size + entries.listeners.size).toBe(0);
  });
});
