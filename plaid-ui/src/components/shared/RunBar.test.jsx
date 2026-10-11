import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { RunBar } from './RunBar.jsx';

// The row over an annotation surface: the run first, the help last, the
// help's panel under the row only while it is open.
describe('RunBar', () => {
  it('puts the run first and the help toggle last, closed', async () => {
    const view = await renderComponent(
      <RunBar run={<button>Parse</button>} helpLabel="Gestures and marks" help={<p>Rows</p>} />,
    );
    const buttons = [...view.container.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Parse', '?Gestures and marks']);
    expect(buttons[1].getAttribute('aria-expanded')).toBe('false');
    expect(view.container.textContent).not.toContain('Rows');
    await view.unmount();
  });

  it('opens the help under the row and closes it again', async () => {
    const view = await renderComponent(<RunBar helpLabel="Keys and marks" help={<p>Rows</p>} />);
    const toggle = view.container.querySelector('button');
    await view.step(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = view.container.querySelector(`[id="${toggle.getAttribute('aria-controls')}"]`);
    expect(panel.textContent).toBe('Rows');
    await view.step(() => toggle.click());
    expect(view.container.textContent).not.toContain('Rows');
    await view.unmount();
  });

  it('draws nothing with nothing to carry', async () => {
    const view = await renderComponent(<RunBar helpLabel="Keys and marks" />);
    expect(view.container.innerHTML).toBe('');
    await view.unmount();
  });
});
