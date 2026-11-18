import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';

// Apart from ProtectedRoute.test.jsx because a sign-out lasts until the page
// reloads (returnTo.js keeps it in the module): a file of its own gets a module
// of its own, so no other test runs after it, in any order.
const { auth } = vi.hoisted(() => ({
  auth: { isAuthenticated: false, loading: false, login: vi.fn() },
}));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));

const { createProtectedRoute } = await import('./ProtectedRoute.jsx');
const { LoginForm } = await import('../auth/LoginForm.jsx');
const ProtectedRoute = createProtectedRoute(() => auth, { loginPath: '/login' });

const Where = () => {
  const l = useLocation();
  return <p id="where">{l.pathname + l.search}</p>;
};

const mount = (at) =>
  renderComponent(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/login" element={<LoginForm tagline="t" homePath="/projects" />} />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <Where />
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

const fill = (container, id, value) => {
  const input = container.querySelector(`#${id}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const signIn = async (view) => {
  auth.login.mockImplementation(async () => {
    auth.isAuthenticated = true;
    return { success: true };
  });
  await view.step(async () => {
    fill(view.container, 'email', 'ada@example.com');
    fill(view.container, 'password', 'pw');
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true }));
  });
};

beforeEach(() => {
  auth.isAuthenticated = false;
  sessionStorage.clear();
});

// REV-FX-H1-2: after a Sign out on a project page, the guard's last render wrote
// that page into the sign-in entry, and the next person to sign in on the tab
// landed on it.
describe('after a sign-out', () => {
  it('sign-in goes home, not to the page the last person was on', async () => {
    const { markSigningOut } = await import('../../lib/returnTo.js');
    markSigningOut();
    const view = await mount('/projects/p1');
    await signIn(view);
    expect(view.container.querySelector('#where').textContent).toBe('/projects');
    await view.unmount();
  });
});
