import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { ServiceRunButton } from './ServiceRunButton.jsx';

describe('ServiceRunButton', () => {
  // The button was rebuilt inside a tooltip when a run started and rebuilt
  // without one when it ended, so focus on it fell to the page both times.
  it('keeps the same button, and its focus, as a run starts and ends', async () => {
    const at = (running) => (
      <ServiceRunButton label="Tokenize" onClick={() => {}} running={running} />
    );
    const view = await renderComponent(at(false));
    const button = view.container.querySelector('button');
    await view.step(() => button.focus());
    await view.rerender(at(true));
    expect(view.container.querySelector('button')).toBe(button);
    expect(document.activeElement).toBe(button);
    await view.rerender(at(false));
    expect(view.container.querySelector('button')).toBe(button);
    expect(document.activeElement).toBe(button);
    await view.unmount();
  });

  // The banner over the document shows the run's clock and progress, so the
  // button only turns.
  it('turns while its run is going, and carries no clock or percent', async () => {
    const view = await renderComponent(
      <ServiceRunButton label="Tokenize" onClick={() => {}} running />,
    );
    const button = view.container.querySelector('button');
    expect(button.querySelector('svg.animate-spin')).not.toBe(null);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent.trim()).toBe('Tokenize');
    expect(document.body.textContent).not.toMatch(/\d:\d\d|%/);
    await view.unmount();
  });
});
