import { describe, expect, it } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { useFollowEnd } from './useFollowEnd.js';

// jsdom lays nothing out, so the box's sizes are set by hand: `height` of
// content in a box `client` tall.
const sized = (el, height, client = 100) => {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => client });
};

// The hook's handle, kept where a test can call `toEnd()` on it.
const handle = {};
const keep = (api) => {
  handle.api = api;
};
const Box = ({ grow, enabled = true }) => {
  const api = useFollowEnd([grow], { enabled });
  keep(api);
  return <div data-testid="box" ref={api.ref} onScroll={api.onScroll} />;
};

const mount = async (props = {}) => {
  const view = await renderComponent(<Box grow={0} {...props} />);
  const box = view.container.querySelector('[data-testid="box"]');
  return { view, box };
};

// The reader scrolling the box to `top`.
const scrollTo = (box, top) => {
  box.scrollTop = top;
  box.dispatchEvent(new Event('scroll'));
};

describe('useFollowEnd', () => {
  it('keeps the box at its end as content grows while the reader is there', async () => {
    const { view, box } = await mount();
    sized(box, 500);
    await view.rerender(<Box grow={1} />);
    expect(box.scrollTop).toBe(500);
    sized(box, 800);
    await view.rerender(<Box grow={2} />);
    expect(box.scrollTop).toBe(800);
  });

  it('leaves the box where the reader scrolled it as content grows', async () => {
    const { view, box } = await mount();
    sized(box, 500);
    await view.rerender(<Box grow={1} />);
    scrollTo(box, 120); // scrolled up to read
    sized(box, 800);
    await view.rerender(<Box grow={2} />);
    expect(box.scrollTop).toBe(120);
  });

  it('follows again once the reader is back at the end', async () => {
    const { view, box } = await mount();
    sized(box, 500);
    scrollTo(box, 120);
    scrollTo(box, 380); // within reach of the end (500 - 100 - 380 = 20)
    sized(box, 800);
    await view.rerender(<Box grow={1} />);
    expect(box.scrollTop).toBe(800);
  });

  it('toEnd takes a scrolled-up box to its end and follows again', async () => {
    const { view, box } = await mount();
    sized(box, 500);
    scrollTo(box, 120);
    await view.step(() => handle.api.toEnd());
    expect(box.scrollTop).toBe(500);
    sized(box, 900);
    await view.rerender(<Box grow={1} />);
    expect(box.scrollTop).toBe(900);
  });

  it('does not move a box it is not asked to follow', async () => {
    const { view, box } = await mount({ enabled: false });
    sized(box, 500);
    await view.rerender(<Box grow={1} enabled={false} />);
    expect(box.scrollTop).toBe(0);
  });
});
