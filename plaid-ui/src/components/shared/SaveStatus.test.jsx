import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { SaveStatus } from './SaveStatus.jsx';

// The save status over an open document in plaid-ud and plaid-umr. They show
// nothing while an edit saves (the edit is on screen already) until it has
// gone 3 s unanswered, and say so while a send waits for the connection to
// come back.

// A document as the status reads it: `isSaving`, `isOffline`, and the
// subscription every DocumentModel has.
const fakeDoc = () => {
  const listeners = new Set();
  let version = 0;
  const doc = {
    isSaving: false,
    isOffline: false,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot: () => version,
    set(fields) {
      Object.assign(doc, fields);
      version += 1;
      listeners.forEach((fn) => fn());
    },
  };
  return doc;
};

describe('SaveStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says nothing while a save is simply on its way', async () => {
    const doc = fakeDoc();
    const view = await renderComponent(<SaveStatus doc={doc} />);
    const status = view.container.querySelector('[role="status"]');
    expect(status.textContent).toBe('');
    await view.step(() => doc.set({ isSaving: true }));
    expect(status.textContent).toBe('');
    await view.unmount();
  });

  // PB-12: a save the server does not answer said nothing until the client
  // gave up resending it, about 13 s in.
  it('says Saving… once a save has gone 3 s without an answer, and goes when it lands', async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const view = await renderComponent(<SaveStatus doc={doc} />);
    const status = view.container.querySelector('[role="status"]');
    await view.step(() => doc.set({ isSaving: true }));
    await view.step(() => vi.advanceTimersByTime(2900));
    expect(status.textContent).toBe('');
    await view.step(() => vi.advanceTimersByTime(200));
    expect(status.textContent).toBe('Saving…');
    expect(status.dataset.state).toBe('saving');
    await view.step(() => doc.set({ isSaving: false }));
    expect(status.textContent).toBe('');
    // The next save starts its 3 s afresh.
    await view.step(() => doc.set({ isSaving: true }));
    await view.step(() => vi.advanceTimersByTime(2900));
    expect(status.textContent).toBe('');
    await view.unmount();
  });

  it('gives way to the retrying words, and says Saving… again if the save is still going once they go', async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const view = await renderComponent(<SaveStatus doc={doc} />);
    const status = view.container.querySelector('[role="status"]');
    await view.step(() => doc.set({ isSaving: true }));
    await view.step(() => vi.advanceTimersByTime(3000));
    expect(status.textContent).toBe('Saving…');
    await view.step(() => doc.set({ isOffline: true }));
    expect(status.textContent).toBe("Can't reach the server, retrying");
    await view.step(() => doc.set({ isOffline: false }));
    expect(status.textContent).toBe('Saving…');
    await view.step(() => doc.set({ isSaving: false }));
    expect(status.textContent).toBe('');
    await view.unmount();
  });

  it('says nothing for a save that fails before 3 s', async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const view = await renderComponent(<SaveStatus doc={doc} />);
    const status = view.container.querySelector('[role="status"]');
    await view.step(() => doc.set({ isSaving: true }));
    await view.step(() => vi.advanceTimersByTime(1000));
    await view.step(() => doc.set({ isSaving: false }));
    await view.step(() => vi.advanceTimersByTime(5000));
    expect(status.textContent).toBe('');
    await view.unmount();
  });

  it('leaves Saving… out where told to, for a card with a progress bar of its own', async () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const view = await renderComponent(<SaveStatus doc={doc} slow={false} />);
    const status = view.container.querySelector('[role="status"]');
    await view.step(() => doc.set({ isSaving: true }));
    await view.step(() => vi.advanceTimersByTime(5000));
    expect(status.textContent).toBe('');
    await view.step(() => doc.set({ isOffline: true }));
    expect(status.textContent).toBe("Can't reach the server, retrying");
    await view.unmount();
  });

  it('says the document is in use while an edit waits for another lock, and goes quiet once sent', async () => {
    const doc = fakeDoc();
    const view = await renderComponent(<SaveStatus doc={doc} />);
    await view.step(() => doc.set({ isSaving: true, isLocked: true }));
    const status = view.container.querySelector('[role="status"]');
    expect(status.textContent).toBe('In use elsewhere, waiting');
    expect(status.dataset.state).toBe('locked');
    await view.step(() => doc.set({ isSaving: false, isLocked: false }));
    expect(status.textContent).toBe('');
    await view.unmount();
  });

  it('says the connection is gone while a refetch waits for it, and goes quiet once it is back', async () => {
    const doc = fakeDoc();
    const view = await renderComponent(<SaveStatus doc={doc} />);
    await view.step(() => doc.set({ isSaving: true, isOffline: true }));
    const status = view.container.querySelector('[role="status"]');
    expect(status.textContent).toBe("Can't reach the server, retrying");
    expect(status.dataset.state).toBe('offline');
    // The browser says it has no network.
    const online = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
    await view.step(() => doc.set({ isOffline: true }));
    expect(status.textContent).toBe('Offline, retrying');
    if (online) Object.defineProperty(window.navigator, 'onLine', online);
    else delete window.navigator.onLine;
    await view.step(() => doc.set({ isOffline: false }));
    expect(status.textContent).toBe('');
    await view.step(() => doc.set({ isSaving: false }));
    expect(status.textContent).toBe('');
    await view.unmount();
  });

  // REV4 J5: nothing about the document changes while a send is retried, so
  // the wording follows the browser's online and offline events.
  it('changes its wording when the browser goes offline or comes back, with nothing else changing', async () => {
    const doc = fakeDoc();
    doc.set({ isSaving: true, isOffline: true });
    const view = await renderComponent(<SaveStatus doc={doc} />);
    const status = view.container.querySelector('[role="status"]');
    expect(status.textContent).toBe("Can't reach the server, retrying");
    const online = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    let isOnline = false;
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => isOnline });
    try {
      await view.step(() => window.dispatchEvent(new Event('offline')));
      expect(status.textContent).toBe('Offline, retrying');
      isOnline = true;
      await view.step(() => window.dispatchEvent(new Event('online')));
      expect(status.textContent).toBe("Can't reach the server, retrying");
    } finally {
      if (online) Object.defineProperty(window.navigator, 'onLine', online);
      else delete window.navigator.onLine;
    }
    await view.unmount();
  });

  it('renders nothing without a document', async () => {
    const view = await renderComponent(<SaveStatus doc={null} />);
    expect(view.container.textContent).toBe('');
    await view.unmount();
  });
});
