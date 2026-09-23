import { describe, it, expect } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { useSavingGuard, anyDocumentSaving } from './useSavingGuard.js';

// A document's writes go on after its screen is gone: the queue is the model's.
// So a reload or a closed tab has to ask while ANY document is still sending,
// not only while the one on screen is. It once asked only from inside the
// document's own screen, and an edit queued there and then walked away from
// was lost when the tab was closed from the project's list.

const fakeDoc = () => {
  const listeners = new Set();
  return {
    isSaving: false,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(saving) {
      this.isSaving = saving;
      listeners.forEach((fn) => fn());
    },
    listeners,
  };
};

// Whether the browser would be told to ask.
const asks = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

const Screen = ({ doc }) => {
  useSavingGuard(doc);
  return null;
};

describe('useSavingGuard', () => {
  it('asks while the open document is sending, and not otherwise', async () => {
    const doc = fakeDoc();
    const view = await renderComponent(<Screen doc={doc} />);
    expect(asks()).toBe(false);
    doc.set(true);
    expect(asks()).toBe(true);
    doc.set(false);
    expect(asks()).toBe(false);
    await view.unmount();
  });

  it('keeps asking after the screen is gone, until the queue has drained', async () => {
    const doc = fakeDoc();
    const view = await renderComponent(<Screen doc={doc} />);
    doc.set(true);
    await view.unmount();

    // The reader is on another screen now, and the write is still out.
    expect(asks()).toBe(true);
    expect(anyDocumentSaving()).toBe(true);

    doc.set(false);
    expect(asks()).toBe(false);
    // Nothing is left watching the document once it has drained.
    expect(doc.listeners.size).toBe(0);
  });

  it('lets go at once of a document with nothing to send', async () => {
    const doc = fakeDoc();
    const view = await renderComponent(<Screen doc={doc} />);
    await view.unmount();
    doc.isSaving = true; // a model nobody holds is nobody's question
    expect(asks()).toBe(false);
  });
});
