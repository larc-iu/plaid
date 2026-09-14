import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useSentenceDeepLink } from './useSentenceDeepLink.js';

// The deep link has to survive being asked for a sentence that is not on the
// page in front of the reader, which is the whole reason it runs twice: the row
// it wants to scroll to is not in the DOM until the page turns. A single-pass
// version scrolls to nothing and reports itself done, which is what a silent
// deep link looks like from the outside.

const PAGE_SIZE = 25;

// Sixty sentences in document order, so s30 is on the second page.
const indexOf = (n) => new Map(Array.from({ length: n }, (_, i) => [`s${i}`, i]));

const Probe = (props) => {
  const flashSentId = useSentenceDeepLink(props);
  return <span data-testid="flash">{flashSentId ?? ''}</span>;
};

const flashOf = (view) => view.container.querySelector('[data-testid="flash"]').textContent;

// One row on screen, so the scroll has something to find.
let rows = [];
const putRow = (id) => {
  const row = document.createElement('div');
  row.setAttribute('data-sentence-row', id);
  row.scrollIntoView = vi.fn();
  document.body.appendChild(row);
  rows.push(row);
  return row;
};

// The hook scrolls inside a frame, so a test has to let one pass.
const runFrame = (view) => view.step(() => vi.advanceTimersByTime(20));

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
});

afterEach(() => {
  vi.useRealTimers();
  rows.forEach((row) => row.remove());
  rows = [];
});

const base = {
  sentParam: null,
  focusNonce: 0,
  ready: true,
  indexById: indexOf(60),
  pageSize: PAGE_SIZE,
  page: 0,
  setPage: () => {},
};

describe('the ?sent= deep link', () => {
  it('turns to the page the sentence is on, and only then scrolls to it', async () => {
    const setPage = vi.fn();
    const view = await renderComponent(<Probe {...base} sentParam="s30" setPage={setPage} />);
    // Page 0 is showing and s30 is on page 1, so the first pass only turns it.
    expect(setPage).toHaveBeenCalledWith(1);
    expect(flashOf(view)).toBe('');

    const row = putRow('s30');
    await view.rerender(<Probe {...base} sentParam="s30" setPage={setPage} page={1} />);
    await runFrame(view);
    expect(row.scrollIntoView).toHaveBeenCalled();
    expect(flashOf(view)).toBe('s30');

    // The flash is a moment, not a state.
    await view.step(() => vi.advanceTimersByTime(2000));
    expect(flashOf(view)).toBe('');
    await view.unmount();
  });

  it('answers the same sentence again only when the nonce moves', async () => {
    const row = putRow('s2');
    const props = { ...base, sentParam: 's2' };
    const view = await renderComponent(<Probe {...props} />);
    await runFrame(view);
    expect(row.scrollIntoView).toHaveBeenCalledTimes(1);

    // The same citation clicked again: the query string is unchanged, so
    // without the nonce there is nothing new to answer.
    await view.rerender(<Probe {...props} />);
    await runFrame(view);
    expect(row.scrollIntoView).toHaveBeenCalledTimes(1);

    await view.rerender(<Probe {...props} focusNonce={1} />);
    await runFrame(view);
    expect(row.scrollIntoView).toHaveBeenCalledTimes(2);
    await view.unmount();
  });

  // The flash is a timer, and a second citation clicked before it comes due
  // leaves the first one's timer running. What it would clear is the flash of
  // the sentence the reader is looking at NOW, which is why the effect cleans
  // up after itself. Only the sequence shows it: either way the second link
  // scrolls where it should, and either way the flash is gone in the end.
  it('a link overtaken by another does not cut the new flash short', async () => {
    const row = putRow('s2');
    const later = putRow('s3');
    const view = await renderComponent(<Probe {...base} sentParam="s2" />);
    await runFrame(view);
    expect(flashOf(view)).toBe('s2');

    // Most of the way through the first flash, a second citation is clicked.
    await view.step(() => vi.advanceTimersByTime(1500));
    await view.rerender(<Probe {...base} sentParam="s3" />);
    await runFrame(view);
    expect(later.scrollIntoView).toHaveBeenCalled();
    expect(flashOf(view)).toBe('s3');

    // Past the moment the FIRST flash was due to end, and still inside the
    // second's.
    await view.step(() => vi.advanceTimersByTime(520));
    expect(flashOf(view)).toBe('s3');

    await view.step(() => vi.advanceTimersByTime(1500));
    expect(flashOf(view)).toBe('');
    expect(row.scrollIntoView).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('does nothing while the document is still being repaired', async () => {
    const setPage = vi.fn();
    const row = putRow('s30');
    const view = await renderComponent(
      <Probe {...base} sentParam="s30" ready={false} setPage={setPage} />,
    );
    await runFrame(view);
    expect(setPage).not.toHaveBeenCalled();
    expect(row.scrollIntoView).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('ignores a sentence this document does not have', async () => {
    const setPage = vi.fn();
    const view = await renderComponent(<Probe {...base} sentParam="s999" setPage={setPage} />);
    await runFrame(view);
    expect(setPage).not.toHaveBeenCalled();
    expect(flashOf(view)).toBe('');
    await view.unmount();
  });

  it('waits for the sentences before answering', async () => {
    const setPage = vi.fn();
    const view = await renderComponent(
      <Probe {...base} sentParam="s30" indexById={new Map()} setPage={setPage} />,
    );
    expect(setPage).not.toHaveBeenCalled();
    await view.rerender(<Probe {...base} sentParam="s30" setPage={setPage} />);
    expect(setPage).toHaveBeenCalledWith(1);
    await view.unmount();
  });
});
