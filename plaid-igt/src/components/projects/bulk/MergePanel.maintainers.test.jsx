import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { refusal } from '../../../../../plaid-client-js/src/testing.js';

// A merge deletes the merged entries, and core lets only a maintainer of the
// vocabulary's project delete its entries, wherever they stand. For a
// vocabulary this project borrows, the panel reads its project: a maintainer
// of it merges, anyone else there is told who can, and someone who cannot
// read it is told it belongs to another project. Only a maintainer previews
// or applies.

const auth = { user: { id: 'u1' } };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
const { MergePanel } = await import('./MergePanel.jsx');

// `projects.get` as core answers it: p2 ("Roots home") with `homeRoles`, to
// a member or an admin, else 403. `broken`: the read fails some other way.
let asked = [];
const client = (home, { homeRoles = {}, broken = false } = {}) => ({
  projects: {
    get: async (id) => {
      asked.push(id);
      if (broken) throw refusal(500, { error: 'Internal error' });
      const p = id === 'p2' ? { id: 'p2', name: 'Roots home', ...homeRoles } : null;
      const member =
        auth.user.isAdmin ||
        [p?.maintainers, p?.writers, p?.readers].some((l) => l?.includes(auth.user.id));
      if (!p || !member) throw refusal(403, { error: 'Forbidden' });
      return p;
    },
  },
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

const mount = async (c, roles = { maintainers: ['u1'] }, home = 'p1') => {
  asked = [];
  const view = await renderComponent(
    <MemoryRouter>
      <MergePanel
        project={{
          id: 'p1',
          name: 'Story',
          ...roles,
          vocabs: [{ id: 'v1', name: 'Lexicon', project: home }],
        }}
        client={c}
      />
    </MemoryRouter>,
  );
  for (let i = 0; i < 4; i++) await view.step(async () => {});
  return view;
};

const tick = async (view, n) => {
  const boxes = all(view.container, 'input[type="checkbox"]');
  for (const box of boxes.slice(0, n)) await view.step(() => box.click());
};
const previewButton = (view) =>
  all(view.container, 'button').find((b) => b.textContent.trim() === 'Preview');

describe('MergePanel and who may merge', () => {
  it('says only a maintainer of the project can merge, and offers no preview', async () => {
    const view = await mount(client('p1'), { maintainers: ['someone-else'], writers: ['u1'] });
    expect(view.container.textContent).toContain(
      'Only a maintainer of “Story” can merge its entries.',
    );
    await tick(view, 2);
    expect(previewButton(view)?.disabled).toBe(true);
    await view.unmount();
  });

  for (const [label, opts] of [
    ['someone with no role in its project', {}],
    [
      'someone whose read of its project fails',
      { homeRoles: { maintainers: ['u1'] }, broken: true },
    ],
  ]) {
    it(`tells ${label} that a borrowed vocabulary belongs to another project`, async () => {
      const view = await mount(client('p2', opts), undefined, 'p2');
      expect(asked).toEqual(['p2']);
      expect(view.container.textContent).toContain('This vocabulary belongs to another project.');
      expect(view.container.textContent).not.toContain('Only a maintainer');
      await tick(view, 2);
      expect(previewButton(view)?.disabled).toBe(true);
      await view.unmount();
    });
  }

  for (const role of ['writers', 'readers']) {
    it(`tells one of the ${role} of a borrowed vocabulary's project who can merge`, async () => {
      const view = await mount(client('p2', { homeRoles: { [role]: ['u1'] } }), undefined, 'p2');
      expect(view.container.textContent).toContain(
        'Only a maintainer of “Roots home” can merge its entries.',
      );
      expect(view.container.textContent).not.toContain('belongs to another project');
      await tick(view, 2);
      expect(previewButton(view)?.disabled).toBe(true);
      await view.unmount();
    });
  }

  it("offers the preview to a maintainer of a borrowed vocabulary's project", async () => {
    const view = await mount(client('p2', { homeRoles: { maintainers: ['u1'] } }), undefined, 'p2');
    expect(view.container.textContent).not.toContain('Only a maintainer');
    expect(view.container.textContent).not.toContain('belongs to another project');
    await tick(view, 2);
    expect(previewButton(view)?.disabled).toBe(false);
    await view.unmount();
  });

  it('offers an admin the preview on a borrowed vocabulary', async () => {
    auth.user = { id: 'root', isAdmin: true };
    try {
      const view = await mount(client('p2'), { maintainers: [] }, 'p2');
      await tick(view, 2);
      expect(previewButton(view)?.disabled).toBe(false);
      await view.unmount();
    } finally {
      auth.user = { id: 'u1' };
    }
  });

  it('offers the preview to a maintainer of the project, and reads no other', async () => {
    const view = await mount(client('p1'));
    expect(asked).toEqual([]);
    expect(view.container.textContent).not.toContain('Only a maintainer');
    expect(view.container.textContent).not.toContain('belongs to another project');
    await tick(view, 2);
    expect(previewButton(view)?.disabled).toBe(false);
    await view.unmount();
  });
});
