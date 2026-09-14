import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useSentenceFocus } from './useSentenceFocus.js';

// Two halves of one gesture, and both are silent when they go wrong: a seed
// that overwrites a richer request loses the word the reader clicked, and a
// citation answered on a tab with no grid on it scrolls nothing while telling
// the panel it was handled.

const KEY = 'igt:focus-sentence';

// The hook returns a function, which cannot be rendered into the DOM the way a
// value can, so the probe hands it out on a stable object.
const hook = {};
const focusHere = (citation) => hook.focusHere(citation);

const Probe = (props) => {
  hook.focusHere = useSentenceFocus(props);
  return null;
};

const seeded = () => JSON.parse(sessionStorage.getItem(KEY) || 'null');

const base = {
  documentId: 'doc-1',
  focusParam: null,
  focusWordParam: NaN,
  activeTab: 'analyze',
};

let events;
const onFocus = (e) => events.push(e.detail);

beforeEach(() => {
  sessionStorage.clear();
  events = [];
  window.addEventListener(KEY, onFocus);
});

afterEach(() => {
  window.removeEventListener(KEY, onFocus);
});

describe('the ?focusSentence= seed', () => {
  it('writes the request the island reads on mount', async () => {
    const view = await renderComponent(<Probe {...base} focusParam="s3" focusWordParam={12} />);
    expect(seeded()).toEqual({ docId: 'doc-1', sentenceId: 's3', begin: 12 });
    await view.unmount();
  });

  it('is written before a child can read it, not in an effect', async () => {
    // The island's shell is a child of this screen, so anything an effect
    // writes arrives after the island has already looked for a key.
    const read = [];
    const Child = () => {
      read.push(sessionStorage.getItem(KEY));
      return null;
    };
    const view = await renderComponent(
      <>
        <Probe {...base} focusParam="s3" focusWordParam={12} />
        <Child />
      </>,
    );
    expect(JSON.parse(read[0])).toEqual({ docId: 'doc-1', sentenceId: 's3', begin: 12 });
    await view.unmount();
  });

  it('leaves a richer request for the same sentence alone', async () => {
    // A search hit writes the key with the matched word's offset, then
    // navigates here. The URL names the sentence only.
    sessionStorage.setItem(KEY, JSON.stringify({ docId: 'doc-1', sentenceId: 's3', begin: 40 }));
    const view = await renderComponent(<Probe {...base} focusParam="s3" />);
    expect(seeded().begin).toBe(40);
    await view.unmount();
  });

  it('overwrites that request when the URL names a word too', async () => {
    sessionStorage.setItem(KEY, JSON.stringify({ docId: 'doc-1', sentenceId: 's3', begin: 40 }));
    const view = await renderComponent(<Probe {...base} focusParam="s3" focusWordParam={7} />);
    expect(seeded().begin).toBe(7);
    await view.unmount();
  });

  it('overwrites a request for a different sentence', async () => {
    sessionStorage.setItem(KEY, JSON.stringify({ docId: 'doc-1', sentenceId: 's9', begin: 40 }));
    const view = await renderComponent(<Probe {...base} focusParam="s3" />);
    expect(seeded()).toEqual({ docId: 'doc-1', sentenceId: 's3', begin: null });
    await view.unmount();
  });

  it('seeds once, so a later render does not re-arm a consumed request', async () => {
    const view = await renderComponent(<Probe {...base} focusParam="s3" />);
    // The island consumes the key and clears it.
    sessionStorage.removeItem(KEY);
    await view.rerender(<Probe {...base} focusParam="s3" activeTab="metadata" />);
    expect(seeded()).toBe(null);
    await view.unmount();
  });

  it('writes nothing when the URL names no sentence', async () => {
    const view = await renderComponent(<Probe {...base} />);
    expect(seeded()).toBe(null);
    await view.unmount();
  });
});

describe('a citation into this document', () => {
  it('asks the grid to scroll and reports the link answered', async () => {
    const view = await renderComponent(<Probe {...base} />);
    expect(focusHere({ documentId: 'doc-1', focus: 's2', begin: 5 })).toBe(true);
    expect(events).toEqual([{ documentId: 'doc-1', focus: 's2', begin: 5 }]);
    await view.unmount();
  });

  it('is declined on a tab with no grid on it', async () => {
    const view = await renderComponent(<Probe {...base} activeTab="export" />);
    expect(focusHere({ documentId: 'doc-1', focus: 's2' })).toBe(false);
    expect(events).toEqual([]);
    await view.unmount();
  });

  it('is declined for another document', async () => {
    const view = await renderComponent(<Probe {...base} />);
    expect(focusHere({ documentId: 'doc-2', focus: 's2' })).toBe(false);
    expect(events).toEqual([]);
    await view.unmount();
  });

  it('is declined when the citation names no sentence', async () => {
    const view = await renderComponent(<Probe {...base} />);
    expect(focusHere({ documentId: 'doc-1', focus: null })).toBe(false);
    expect(events).toEqual([]);
    await view.unmount();
  });

  it('follows the tab the reader moved to', async () => {
    const view = await renderComponent(<Probe {...base} activeTab="export" />);
    expect(focusHere({ documentId: 'doc-1', focus: 's2' })).toBe(false);
    await view.rerender(<Probe {...base} activeTab="analyze" />);
    expect(focusHere({ documentId: 'doc-1', focus: 's2' })).toBe(true);
    await view.unmount();
  });

  it('survives storage that throws', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const view = await renderComponent(<Probe {...base} focusParam="s3" />);
    expect(focusHere({ documentId: 'doc-1', focus: 's2' })).toBe(true);
    spy.mockRestore();
    await view.unmount();
  });
});
