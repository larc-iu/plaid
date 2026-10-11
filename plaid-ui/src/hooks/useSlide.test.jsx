import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { SLIDE_MS, useSlide } from './useSlide.js';

// A side panel slides in and out, and stays on screen through its slide out.

const Probe = ({ open }) => {
  const { mounted, entered } = useSlide(open);
  return <span data-testid="s">{mounted ? (entered ? 'in' : 'out') : 'gone'}</span>;
};
const read = (container) => container.querySelector('[data-testid="s"]').textContent;

describe('useSlide', () => {
  let spies;
  beforeEach(() => {
    vi.useFakeTimers();
    spies = [
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((f) => window.setTimeout(f, 16)),
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id)),
    ];
  });
  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
    vi.useRealTimers();
  });

  it('starts in place when it starts open, with no slide', async () => {
    const r = await renderComponent(<Probe open />);
    expect(read(r.container)).toBe('in');
    await r.unmount();
  });

  it('mounts out of place on open and moves in a frame later', async () => {
    const r = await renderComponent(<Probe open={false} />);
    expect(read(r.container)).toBe('gone');
    await r.rerender(<Probe open />);
    expect(read(r.container)).toBe('out');
    await r.step(() => vi.advanceTimersByTime(40));
    expect(read(r.container)).toBe('in');
    await r.unmount();
  });

  it('slides out on close and unmounts once the slide is done', async () => {
    const r = await renderComponent(<Probe open />);
    await r.rerender(<Probe open={false} />);
    expect(read(r.container)).toBe('out');
    await r.step(() => vi.advanceTimersByTime(SLIDE_MS + 1));
    expect(read(r.container)).toBe('gone');
    await r.unmount();
  });
});
