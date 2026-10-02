import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { ServiceRunButton } from './ServiceRunButton.jsx';

// The button was rebuilt inside a tooltip when a run started and rebuilt
// without one when it ended, so focus on it fell to the page both times.
describe('ServiceRunButton', () => {
  it('keeps the same button, and its focus, as a run starts and ends', async () => {
    const at = (progress) => (
      <ServiceRunButton label="Tokenize" onClick={() => {}} progress={progress} />
    );
    const view = await renderComponent(at(null));
    const button = view.container.querySelector('button');
    await view.step(() => button.focus());
    await view.rerender(at({ running: true, elapsedMs: 1000 }));
    expect(view.container.querySelector('button')).toBe(button);
    expect(document.activeElement).toBe(button);
    await view.rerender(at({ running: false }));
    expect(view.container.querySelector('button')).toBe(button);
    expect(document.activeElement).toBe(button);
    await view.unmount();
  });
});
