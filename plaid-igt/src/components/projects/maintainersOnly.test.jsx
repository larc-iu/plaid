import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// H15-IGT polish: a reader who opened the setup wizard or Add ELAN documents by
// address saw the whole wizard. They go to the project, told why, and the
// wizard never shows, not even while the project loads.

const notified = vi.hoisted(() => []);
vi.mock('@ui/hooks/useManagedProject.js', () => ({
  notifyNotAMaintainer: () => notified.push('not a maintainer'),
}));

const auth = vi.hoisted(() => ({ value: null }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }));
// The wizard's own client is the stand-in itself.
vi.mock('@/hooks/useClientApart', () => ({ useClientApart: (client) => client }));

const { ProjectSetup } = await import('./ProjectSetup.jsx');
const { ImportElanDocuments } = await import('./ImportElanDocuments.jsx');

const PROJECT = { id: 'p1', name: 'Story', maintainers: ['m@x.com'], readers: ['r@x.com'] };

const signIn = (id, get) => {
  auth.value = {
    user: { id, isAdmin: false },
    client: {
      projects: { get, listDocuments: async () => [] },
      documents: { list: async () => [] },
      server: { limits: async () => null },
    },
  };
};

const mount = (screen, element) =>
  renderComponent(
    <MemoryRouter initialEntries={[`/projects/p1/${screen}`]}>
      <Routes>
        <Route path={`/projects/:projectId/${screen}`} element={element} />
        <Route path="/projects/:projectId" element={<p>the project page</p>} />
      </Routes>
    </MemoryRouter>,
  );

const settle = (view) => view.step(() => new Promise((r) => setTimeout(r, 0)));

describe.each([
  ['setup', () => <ProjectSetup />, 'Project setup'],
  ['import-elan', () => <ImportElanDocuments />, 'Add ELAN documents'],
])('/projects/:id/%s', (screen, element, heading) => {
  beforeEach(() => {
    notified.length = 0;
  });

  it('sends a reader to the project, told why, and never shows the wizard', async () => {
    let answer;
    signIn('r@x.com', () => new Promise((r) => (answer = r)));
    const view = await mount(screen, element());
    expect(view.container.textContent).not.toContain(heading);
    await view.step(() => answer(PROJECT));
    await settle(view);
    expect(view.container.textContent).toContain('the project page');
    expect(notified).toEqual(['not a maintainer']);
    await view.unmount();
  });

  // R57 (REV-FX-R57 S5): a project whose import did not finish does not open,
  // this screen included.
  it('shows a maintainer of a project whose import did not finish only that, with Delete', async () => {
    const unfinished = { ...PROJECT, config: { igt: { import: { kind: 'ELAN', source: null } } } };
    signIn('m@x.com', async () => unfinished);
    const view = await mount(screen, element());
    await settle(view);
    expect(view.container.textContent).not.toContain(heading);
    expect(view.container.textContent).toContain(
      'This import did not finish. Delete it and import again.',
    );
    expect(
      [...view.container.querySelectorAll('button')].some((b) => b.textContent === 'Delete'),
    ).toBe(true);
    await view.unmount();
  });

  it('shows a maintainer the wizard', async () => {
    signIn('m@x.com', async () => PROJECT);
    const view = await mount(screen, element());
    await settle(view);
    expect(view.container.textContent).toContain(heading);
    expect(notified).toEqual([]);
    await view.unmount();
  });
});
