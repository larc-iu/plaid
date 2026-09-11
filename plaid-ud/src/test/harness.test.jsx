// The component-test harness itself. Not a test of any screen: it exists so a
// failure in the scaffolding (React, happy-dom, or the path aliases) is
// reported here rather than as a puzzling failure inside the first real
// component test.
import { describe, it, expect } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { Button } from '@ui/components/ui/button.jsx';
import { PROVENANCE_KEYS } from '@larc-iu/plaid-client';

// Declared here rather than imported: these two tests are about the harness,
// so they must not fail because some screen's component changed.
const Greeting = ({ name }) => <p data-testid="greeting">Hello, {name}</p>;

describe('the component-test harness', () => {
  it('mounts a component and reads it off the DOM', async () => {
    const view = await renderComponent(<Greeting name="Ada" />);
    expect(view.container.querySelector('[data-testid="greeting"]').textContent).toBe('Hello, Ada');
    await view.unmount();
  });

  it('re-renders with new props against the same root', async () => {
    const view = await renderComponent(<Greeting name="Ada" />);
    const first = view.container.querySelector('[data-testid="greeting"]');
    await view.rerender(<Greeting name="Grace" />);
    const second = view.container.querySelector('[data-testid="greeting"]');
    expect(second.textContent).toBe('Hello, Grace');
    expect(second).toBe(first); // the same node, updated in place
    await view.unmount();
  });

  it('resolves the plaid-client alias', () => {
    expect(PROVENANCE_KEYS).toBeTruthy();
  });

  // The shared package resolves through a node_modules symlink, and its own
  // bare imports (react, class-variance-authority) have to land in THIS app's
  // node_modules. A wrong alias fails to resolve rather than failing an
  // assertion, which is why this renders one of its components rather than
  // importing a constant.
  it('renders a component from plaid-ui', async () => {
    const view = await renderComponent(<Button variant="secondary">Save</Button>);
    const button = view.container.querySelector('button');
    expect(button.textContent).toBe('Save');
    expect(button.className).toContain('bg-secondary');
    await view.unmount();
  });
});
