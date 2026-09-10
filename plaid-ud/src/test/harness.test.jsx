// The component-test harness itself. Not a test of any screen: it exists so a
// failure in the scaffolding (React, happy-dom, the path aliases, or the two UI
// stacks refusing to coexist) is reported here rather than as a puzzling
// failure inside the first real component test.
//
// Screens get their own tests as they migrate in 0.3 to 0.5.
import { describe, it, expect } from 'vitest';
import { MantineProvider } from '@mantine/core';
import { renderComponent, texts } from '@/test/renderComponent.jsx';
import { EntityAvatar } from '@/components/common/EntityAvatar.jsx';
import { PROVENANCE_KEYS } from '@larc-iu/plaid-client';

describe('the component-test harness', () => {
  it('mounts a component and reads it off the DOM', async () => {
    const view = await renderComponent(<EntityAvatar id="019ecd83-7617-7501-b200-131681d59b7c" />);
    const img = view.container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    await view.unmount();
  });

  it('re-renders with new props against the same root', async () => {
    const view = await renderComponent(<EntityAvatar id="a" />);
    const first = view.container.querySelector('img').getAttribute('src');
    await view.rerender(<EntityAvatar id="b" />);
    expect(view.container.querySelector('img').getAttribute('src')).not.toEqual(first);
    await view.unmount();
  });

  // Both stacks have to render in the same test run for the length of the
  // migration: a screen already on shadcn and one still on Mantine are siblings
  // under one root until 0.5 removes the second.
  it('renders a Mantine subtree and a Tailwind-classed one side by side', async () => {
    const view = await renderComponent(
      <MantineProvider>
        <div>
          <p data-testid="mantine">Mantine</p>
          <div className="tw">
            <p data-testid="shadcn" className="text-sm text-muted-foreground">
              Tailwind
            </p>
          </div>
        </div>
      </MantineProvider>,
    );
    expect(texts(view.container, 'p')).toEqual(['Mantine', 'Tailwind']);
    await view.unmount();
  });

  it('resolves the plaid-client alias', () => {
    expect(PROVENANCE_KEYS).toBeTruthy();
  });
});
