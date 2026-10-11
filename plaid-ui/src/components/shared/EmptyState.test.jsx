import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { EmptyState } from './EmptyState.jsx';

// An empty list in every app: a swatch, a line, maybe an action.
describe('EmptyState', () => {
  it("wears the project's plaid inside a project", async () => {
    const view = await renderComponent(
      <EmptyState project={{ id: 'p1', config: {} }} title="No documents yet." />,
    );
    expect(view.container.querySelector('[data-testid="project-tartan"]')).not.toBeNull();
    expect(view.container.textContent).toBe('No documents yet.');
    await view.unmount();
  });

  it("wears the product's mark without a project or with its plaid off", async () => {
    for (const project of [undefined, { id: 'p1', config: { plaid: { tartan: false } } }]) {
      const view = await renderComponent(
        <EmptyState project={project} title="Nothing." action={<button>Add</button>} />,
      );
      expect(view.container.querySelector('[data-testid="project-tartan"]')).toBeNull();
      expect(view.container.querySelector('svg')).not.toBeNull();
      expect(view.container.querySelector('button').textContent).toBe('Add');
      await view.unmount();
    }
  });
});
