import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// A merge deletes the merged entries, and core lets only a maintainer of the
// vocabulary delete its entries (acl-shared-vocab-writers, ruled b). A
// project maintainer who does not maintain the vocabulary is told so, and
// nothing can be previewed or applied.

const auth = { user: { id: 'u1' } };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
const { MergePanel } = await import('./MergePanel.jsx');

const client = (maintainers) => ({
  vocabLayers: {
    get: async (id, withItems) => ({
      id,
      name: 'Lexicon',
      maintainers,
      timeModified: null,
      config: {},
      ...(withItems
        ? {
            items: [
              { id: 'a', form: 'kat' },
              { id: 'b', form: 'kata' },
            ],
          }
        : {}),
    }),
  },
});

const mount = async (c) => {
  const view = await renderComponent(
    <MemoryRouter>
      <MergePanel project={{ id: 'p1', vocabs: [{ id: 'v1', name: 'Lexicon' }] }} client={c} />
    </MemoryRouter>,
  );
  for (let i = 0; i < 4; i++) await view.step(async () => {});
  return view;
};

const tick = async (view, n) => {
  const boxes = all(document.body, 'input[type="checkbox"]');
  for (const box of boxes.slice(0, n)) await view.step(() => box.click());
};
const previewButton = () =>
  all(document.body, 'button').find((b) => b.textContent.trim() === 'Preview');

describe('MergePanel for someone who does not maintain the vocabulary', () => {
  it('says only a maintainer can merge, and offers no preview', async () => {
    const view = await mount(client(['someone-else']));
    expect(document.body.textContent).toContain(
      'Only a maintainer of this vocabulary can merge its entries.',
    );
    await tick(view, 2);
    expect(previewButton()?.disabled).toBe(true);
    await view.unmount();
  });

  it('offers the preview to a maintainer', async () => {
    const view = await mount(client(['u1']));
    expect(document.body.textContent).not.toContain('Only a maintainer');
    await tick(view, 2);
    expect(previewButton()?.disabled).toBe(false);
    await view.unmount();
  });
});
