import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';
import { LoginForm } from './LoginForm.jsx';

const { auth, navigate } = vi.hoisted(() => ({
  auth: { login: vi.fn() },
  navigate: vi.fn(),
}));

vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => navigate,
}));

const mount = () =>
  renderComponent(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginForm tagline="A tagline" homePath="/somewhere" />} />
      </Routes>
    </MemoryRouter>,
  );

const fill = (container, id, value) => {
  const input = container.querySelector(`#${id}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const submit = (container) =>
  container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true }));

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('names the app from the package config, and the tagline from the app', async () => {
    const { container } = await mount();
    // The setup file configures the package as plaid-igt for the whole run.
    expect(container.textContent).toContain('Plaid IGT Login');
    expect(container.textContent).toContain('A tagline');
  });

  it('requires both fields and focuses the first, so the browser stops an empty submit', async () => {
    const { container } = await mount();
    expect(container.querySelector('#email').required).toBe(true);
    expect(container.querySelector('#password').required).toBe(true);
    expect(document.activeElement).toBe(container.querySelector('#email'));
  });

  it('lands on the app’s own home and clears the logout reason', async () => {
    sessionStorage.setItem('plaid:logout-reason', 'expired');
    auth.login.mockResolvedValue({ success: true });
    const { container, step } = await mount();

    expect(container.querySelector('[role="status"]').textContent).toContain(
      'Your session has expired',
    );

    await step(async () => {
      fill(container, 'email', 'ada@example.com');
      fill(container, 'password', 'pw');
      submit(container);
    });

    expect(auth.login).toHaveBeenCalledWith('ada@example.com', 'pw');
    expect(navigate).toHaveBeenCalledWith('/somewhere');
    expect(sessionStorage.getItem('plaid:logout-reason')).toBe(null);
  });

  it('shows what the refusal was, and says nothing on success', async () => {
    auth.login.mockResolvedValue({ success: false, error: 'Email or password is incorrect.' });
    const { container, step } = await mount();

    await step(async () => {
      fill(container, 'email', 'ada@example.com');
      fill(container, 'password', 'wrong');
      submit(container);
    });

    expect(container.querySelector('[role="alert"]').textContent).toBe(
      'Email or password is incorrect.',
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('describes a thrown failure without leaking it', async () => {
    auth.login.mockRejectedValue(new Error('fetch failed at http://localhost:8085/api/v1/login'));
    const { container, step } = await mount();

    await step(async () => {
      fill(container, 'email', 'ada@example.com');
      fill(container, 'password', 'pw');
      submit(container);
    });

    expect(container.querySelector('[role="alert"]').textContent).toBe(
      'Something went wrong. Try again.',
    );
  });
});
