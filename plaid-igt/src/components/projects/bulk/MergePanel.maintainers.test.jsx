import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// A merge deletes the merged entries, and core lets only a maintainer of the
// vocabulary's project delete its entries. A vocabulary this project borrows
// from another is read only here, even for someone who also maintains that
// project, and someone who does not maintain this project's own vocabulary's
// project is told so. Neither can preview or apply.

const auth = { user: { id: 'u1' } };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
const { MergePanel } = await import('./MergePanel.jsx');

const client = (home) => ({
  vocabLayers: {
    get: async (id, withItems) => ({
      id,
      name: 'Lexicon',
      project: home,
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

const mount = async (c, roles = { maintainers: ['u1'] }) => {
  const view = await renderComponent(
    <MemoryRouter>
      <MergePanel
        project={{
          id: 'p1',
          name: 'Story',
          ...roles,
          vocabs: [{ id: 'v1', name: 'Lexicon', project: 'p1' }],
        }}
        client={c}
      />
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

describe('MergePanel and who may merge', () => {
  it('says only a maintainer of the project can merge, and offers no preview', async () => {
    const view = await mount(client('p1'), { maintainers: ['someone-else'], writers: ['u1'] });
    expect(document.body.textContent).toContain(
      'Only a maintainer of “Story” can merge its entries.',
    );
    await tick(view, 2);
    expect(previewButton()?.disabled).toBe(true);
    await view.unmount();
  });

  it('says a borrowed vocabulary belongs to another project, and offers no preview', async () => {
    const view = await mount(client('p-other'));
    expect(document.body.textContent).toContain('This vocabulary belongs to another project.');
    expect(document.body.textContent).not.toContain('Only a maintainer');
    await tick(view, 2);
    expect(previewButton()?.disabled).toBe(true);
    await view.unmount();
  });

  it('offers the preview to a maintainer of the project', async () => {
    const view = await mount(client('p1'));
    expect(document.body.textContent).not.toContain('Only a maintainer');
    expect(document.body.textContent).not.toContain('belongs to another project');
    await tick(view, 2);
    expect(previewButton()?.disabled).toBe(false);
    await view.unmount();
  });
});
