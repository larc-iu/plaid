// The two links at the left of every app's header: the Plaid mark leads to /,
// the root the jar serves, and the app's name to the app's own projects.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, all } from '../../test/renderComponent.jsx';

const { auth } = vi.hoisted(() => ({
  auth: { user: { id: 'u', displayName: 'You', isAdmin: false }, logout: () => {} },
}));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../assistant/AssistantChrome.jsx', () => ({
  AssistantChrome: ({ children, className }) => (
    <div className={className}>{children({ chip: null })}</div>
  ),
}));
vi.mock('./UserButton', () => ({ UserButton: () => null }));
auth.getClient = () => ({ users: { avatarUrl: () => null } });

const { AppShell } = await import('./AppShell.jsx');

let view = null;
afterEach(async () => {
  if (view) await view.unmount();
  view = null;
});

const mount = async () => {
  view = await renderComponent(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={<p>the screen</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
};

const headerLinks = () =>
  all(view.container, 'header a').map((a) => ({
    name: a.getAttribute('aria-label') ?? a.textContent,
    href: a.getAttribute('href'),
    hasMark: !!a.querySelector('svg'),
  }));

describe('the header’s mark and name', () => {
  it('links the mark to / and the name to the projects', async () => {
    await mount();
    const [mark, name] = headerLinks();
    expect(mark).toEqual({ name: 'Plaid home', href: '/', hasMark: true });
    expect(name).toEqual({ name: 'Plaid IGT', href: '/projects', hasMark: false });
  });
});
