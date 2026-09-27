import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { RunBanner } from './RunBanner.jsx';

// The banner a writing run puts over a document wears the shared warning
// tone, and its icon still turns: the run is moving, and the anti-hang rule
// wants that visible on every tab.

describe('RunBanner', () => {
  it('is a warning notice with a turning icon, the clock and the status line', async () => {
    const view = await renderComponent(
      <RunBanner label="Parse" startedAt={Date.now()} status="Sentence 3 of 40." />,
    );
    const box = view.container.querySelector('[data-tone]');
    expect(box.getAttribute('data-tone')).toBe('warning');
    expect(box.querySelector('svg.animate-spin')).not.toBe(null);
    expect(box.querySelector('[role="status"]').textContent).toBe(
      'Parse is running. Sentence 3 of 40.',
    );
    expect(view.container.innerHTML).not.toMatch(/amber-/);
    await view.unmount();
  });

  it('keeps its Stop button while it wears the notice, and only when the run can stop', async () => {
    let stopped = 0;
    const view = await renderComponent(
      <RunBanner label="Parse" startedAt={Date.now()} cancel={() => (stopped += 1)} />,
    );
    const stop = [...view.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Stop',
    );
    expect(stop).toBeTruthy();
    await view.step(() => stop.click());
    expect(stopped).toBe(1);
    await view.rerender(<RunBanner label="Parse" startedAt={Date.now()} />);
    expect(view.container.querySelector('button')).toBe(null);
    // The status line is never blank, even before the run has said anything.
    expect(view.container.querySelector('[role="status"]').textContent).toBe('Parse is running.');
    await view.unmount();
  });
});
