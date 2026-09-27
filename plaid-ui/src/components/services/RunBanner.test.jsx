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
});
