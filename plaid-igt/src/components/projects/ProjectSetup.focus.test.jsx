import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// A new step of the setup puts focus on its heading, wherever the step was
// changed from (Next, Previous, or Enter in a field, which left focus on the
// page body before).

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ client: {} }) }));

const { ProjectSetup } = await import('./ProjectSetup.jsx');

const button = (container, text) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

const typeInto = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('the project setup steps', () => {
  it('focuses the new step heading, unless the step put focus in its own field', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <ProjectSetup />
      </MemoryRouter>,
    );
    const heading = () => view.container.querySelector('h2');
    expect(document.activeElement).not.toBe(heading());
    await view.step(() => typeInto(view.container.querySelector('input'), 'Kbd'));
    await view.step(() => button(view.container, 'Next').click());
    expect(document.activeElement).toBe(heading());
    expect(heading().textContent).not.toBe('Basic information');
    await view.step(() => button(view.container, 'Previous').click());
    expect(heading().textContent).toBe('Basic information');
    // That step puts the caret in Project name itself, and keeps it.
    expect(document.activeElement).toBe(view.container.querySelector('input'));
    await view.unmount();
  });
});
