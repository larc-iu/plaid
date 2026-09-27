import { describe, it, expect, vi } from 'vitest';
import { useEffect } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';

// A change made on the Access screen (a role, a member added from the search)
// re-reads the project. The screen must stay mounted through that read: it
// holds the search being typed, the optimistic role and any open dialog, and
// a Loading line in its place threw all of them away on every change.

const screen = vi.hoisted(() => ({ mounts: 0, onDataUpdate: null, project: null }));
vi.mock('./ProjectAccessScreen.jsx', () => ({
  ProjectAccessScreen: ({ onDataUpdate, project }) => {
    screen.onDataUpdate = onDataUpdate;
    screen.project = project;
    useEffect(() => {
      screen.mounts += 1;
    }, []);
    return <div data-testid="screen">{project.name}</div>;
  },
}));
vi.mock('../../lib/notify.js', () => ({ notifyError: vi.fn() }));

const auth = vi.hoisted(() => ({ getClient: vi.fn(), user: { id: 'u', isAdmin: false } }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));

const { ProjectAccessSettings } = await import('./ProjectAccessSettings.jsx');

const app = (onProjectUpdate) => (
  <MemoryRouter initialEntries={['/projects/A/access']}>
    <Routes>
      <Route
        path="/projects/:projectId/access"
        element={
          <ProjectAccessSettings
            roleOptions={[]}
            profileHref="/profile"
            onProjectUpdate={onProjectUpdate}
          />
        }
      />
    </Routes>
  </MemoryRouter>
);

describe('the Access section after a change', () => {
  it('re-reads the project without unmounting the screen, then tells the host', async () => {
    let answer;
    let version = 0;
    auth.getClient.mockReturnValue({
      projects: {
        get: () =>
          new Promise((resolve) => {
            version += 1;
            answer = () => resolve({ id: 'A', name: `Ay ${version}`, maintainers: ['u'] });
          }),
      },
    });
    const onProjectUpdate = vi.fn();
    const view = await renderComponent(app(onProjectUpdate));
    await view.step(async () => answer());
    expect(screen.mounts).toBe(1);
    expect(screen.project.name).toBe('Ay 1');

    let done;
    await view.step(() => {
      done = screen.onDataUpdate();
    });
    // The read is in flight: the screen is still there, not a Loading line.
    expect(view.container.querySelector('[data-testid="screen"]')).not.toBeNull();
    await view.step(async () => {
      answer();
      await done;
    });

    expect(screen.mounts).toBe(1);
    expect(screen.project.name).toBe('Ay 2');
    expect(onProjectUpdate).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
