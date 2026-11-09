import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';

// H1-4: a link opened while signed out landed on the app's home after sign-in,
// and the document it named was gone.
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

describe('a link opened while signed out', () => {
  it('opens after sign-in', async () => {
    const view = await mount('/projects/p1/documents/d1?tab=analyze');
    expect(view.container.querySelector('#email')).not.toBeNull();
    await signIn(view);
    expect(view.container.querySelector('#where').textContent).toBe(
      '/projects/p1/documents/d1?tab=analyze',
    );
    await view.unmount();
  });

  it('opens after a session that ended there', async () => {
    sessionStorage.setItem('plaid:return-to', '/projects/p2/documents/d2?tab=text');
    const view = await mount('/login');
    await signIn(view);
    expect(view.container.querySelector('#where').textContent).toBe(
      '/projects/p2/documents/d2?tab=text',
    );
    expect(sessionStorage.getItem('plaid:return-to')).toBe(null);
    await view.unmount();
  });

  it('goes home for anything that is not a path of the app', async () => {
    for (const bad of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', '/login']) {
      sessionStorage.setItem('plaid:return-to', bad);
      auth.isAuthenticated = false;
      const view = await mount('/login');
      await signIn(view);
      expect(view.container.querySelector('#where').textContent).toBe('/projects');
      await view.unmount();
    }
  });
});
