import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// One rule for Save in every app: the default button, disabled until its
// section differs from what is stored. This tab has one Save for all of it, and
// it used to be enabled with nothing changed.

const managed = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/hooks/useManagedProject.js', () => ({ useManagedProject: () => managed.current }));
vi.mock('../../contexts/AuthContext.jsx', () => ({ useAuth: () => ({ getClient: () => null }) }));

// The tab reads the project only through this resolver, so a hand-made answer
// stands in for a configured project.
const info = vi.hoisted(() => ({
  isConfigured: true,
  vocab: {
    upos: ['NOUN', 'VERB'],
    xpos: [],
    deprel: ['nsubj'],
    featureInventory: { list: [{ key: 'Number', values: ['Sing'] }] },
  },
  colors: { upos: {}, deprel: {} },
  modes: {},
  descriptions: { upos: {}, xpos: {}, deprel: {}, feats: {} },
}));
vi.mock('../../utils/udLayerUtils.js', async (orig) => ({
  ...(await orig()),
  getUdLayerInfo: () => info,
}));

const { ProjectCustomization } = await import('./ProjectCustomization.jsx');

const button = (root, text) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

const mount = () =>
  renderComponent(
    <MemoryRouter>
      <ProjectCustomization />
    </MemoryRouter>,
  );

beforeEach(() => {
  managed.current = {
    project: { id: 'p1', name: 'P', config: {} },
    loading: false,
    fetchProject: vi.fn(),
    canConfigure: true,
  };
});

describe('UD customization', () => {
  it('keeps Save disabled until something on the tab changes, and again once undone', async () => {
    const view = await mount();
    const save = button(view.container, 'Save customization');
    expect(save.disabled).toBe(true);
    await view.step(() => button(view.container, 'Add feature').click());
    expect(save.disabled).toBe(false);
    await view.step(() => view.container.querySelector('[aria-label="Remove feature"]').click());
    expect(save.disabled).toBe(true);
    await view.unmount();
  });

  it('draws a feature row trash grey, red only on hover', async () => {
    const view = await mount();
    const trash = view.container.querySelector('[aria-label="Remove Number"]');
    const classes = trash.className.split(/\s+/);
    expect(classes).toContain('text-muted-foreground');
    expect(classes).toContain('hover:text-destructive');
    expect(classes).not.toContain('text-destructive');
    await view.unmount();
  });
});
