import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, byText } from '../../test/renderComponent.jsx';
import { RedeemInvite } from './RedeemInvite.jsx';

const { authService, auth, notifySuccess } = vi.hoisted(() => ({
  authService: { lookupInvite: vi.fn() },
  auth: { redeemInvite: vi.fn(), user: null },
  notifySuccess: vi.fn(),
}));

vi.mock('../../services/auth.js', () => ({ authService }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../../lib/notify.js', () => ({ notifySuccess }));

const ACTIVE = { status: 'active', kind: 'signup', projectName: 'Lezgi', projectRole: 'writer' };

const mount = () =>
  renderComponent(
    <MemoryRouter initialEntries={['/invite/CODE']}>
      <Routes>
        <Route
          path="/invite/:code"
          element={<RedeemInvite loginPath="/login" homePath="/projects" />}
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

const submit = (container) =>
  container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true }));

const alertText = (container) => container.querySelector('[role="alert"]')?.textContent ?? '';

describe('RedeemInvite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = null;
    authService.lookupInvite.mockResolvedValue(ACTIVE);
  });

  it('names what the project is offering', async () => {
    const { container } = await mount();
    expect(container.textContent).toContain('You have been invited to join Lezgi as a writer.');
  });

  it('says why a dead code is dead, and offers the app’s own sign-in route', async () => {
    authService.lookupInvite.mockResolvedValue({ status: 'expired', kind: 'signup' });
    const { container } = await mount();

    expect(alertText(container)).toContain('This invite has expired');
    expect(byText(container, 'a', 'Go to sign in').getAttribute('href')).toBe('/login');
    expect(container.querySelector('form')).toBe(null);
  });

  it('refuses a short password and a mismatch before asking the server', async () => {
    const { container, step } = await mount();

    await step(async () => {
      fill(container, 'invite-email', 'ada@example.com');
      fill(container, 'invite-password', 'short');
      fill(container, 'invite-confirm', 'short');
      submit(container);
    });
    expect(alertText(container)).toBe('Password must be at least 8 characters');

    await step(async () => {
      fill(container, 'invite-password', 'longenough');
      fill(container, 'invite-confirm', 'longenoughtoo');
      submit(container);
    });
    expect(alertText(container)).toBe('Passwords do not match');
    expect(auth.redeemInvite).not.toHaveBeenCalled();
  });

  it('refuses an address that is not one', async () => {
    const { container, step } = await mount();
    await step(async () => {
      fill(container, 'invite-email', 'not-an-address');
      fill(container, 'invite-password', 'longenough');
      fill(container, 'invite-confirm', 'longenough');
      submit(container);
    });
    expect(alertText(container)).toBe('That does not look like an email address');
    expect(auth.redeemInvite).not.toHaveBeenCalled();
  });

  it('rewords a 409 as the question the reader is actually asking', async () => {
    auth.redeemInvite.mockResolvedValue({ success: false, status: 409 });
    const { container, step } = await mount();

    await step(async () => {
      fill(container, 'invite-email', 'ada@example.com');
      fill(container, 'invite-password', 'longenough');
      fill(container, 'invite-confirm', 'longenough');
      submit(container);
    });
    expect(alertText(container)).toBe('An account already exists for that email address.');
  });

  it('sends a blank display name as nothing, so the server can default it', async () => {
    auth.redeemInvite.mockResolvedValue({ success: true });
    const { container, step } = await mount();

    await step(async () => {
      fill(container, 'invite-email', '  ada@example.com  ');
      fill(container, 'invite-password', 'longenough');
      fill(container, 'invite-confirm', 'longenough');
      submit(container);
    });
    expect(auth.redeemInvite).toHaveBeenCalledWith('CODE', {
      email: 'ada@example.com',
      displayName: undefined,
      password: 'longenough',
    });
    expect(notifySuccess).toHaveBeenCalledWith('Your account is ready.', 'Welcome');
  });

  it('warns a signed-in reader what accepting will do to their session', async () => {
    auth.user = { displayName: 'Ada' };
    const { container } = await mount();
    expect(container.textContent).toContain('You are signed in as Ada');
    expect(container.textContent).toContain('creates a separate account');
  });

  it('asks only for a password on a reset link', async () => {
    authService.lookupInvite.mockResolvedValue({
      status: 'active',
      kind: 'password-reset',
      email: 'ada@example.com',
    });
    const { container } = await mount();

    expect(container.textContent).toContain('Choose a new password for ada@example.com.');
    expect(container.querySelector('#invite-email')).toBe(null);
    expect(container.querySelector('#invite-password')).not.toBe(null);
  });
});
