import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { renderComponent, byText } from '../../test/renderComponent.jsx';
import { RedeemInvite } from './RedeemInvite.jsx';

const { authService, auth, notifySuccess } = vi.hoisted(() => ({
  authService: { lookupInvite: vi.fn(), serverLimits: vi.fn() },
  auth: { redeemInvite: vi.fn(), user: null, client: null },
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
    authService.serverLimits.mockResolvedValue({ passwordMinLength: 8 });
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

  it('says a link whose creator lost access no longer works, and whom to ask', async () => {
    authService.lookupInvite.mockResolvedValue({ ...ACTIVE, status: 'inactive' });
    const { container } = await mount();
    expect(alertText(container)).toBe(
      'This invite no longer works. Ask a maintainer of Lezgi for a new link.',
    );
    expect(container.querySelector('form')).toBe(null);
  });

  it('sends an inactive link with no project to an administrator', async () => {
    authService.lookupInvite.mockResolvedValue({
      status: 'inactive',
      kind: 'password-reset',
      email: 'ada@example.com',
    });
    const { container } = await mount();
    expect(alertText(container)).toBe(
      'This invite no longer works. Ask an administrator for a new link.',
    );
    expect(container.querySelector('form')).toBe(null);
  });

  it('refuses a short password and a mismatch before asking the server', async () => {
    const { container, step } = await mount();

    await step(async () => {
      fill(container, 'invite-email', 'ada@example.com');
      fill(container, 'invite-password', 'abc1234');
      fill(container, 'invite-confirm', 'abc1234');
      submit(container);
    });
    expect(alertText(container)).toBe('Password must be at least 8 characters');
    expect(container.textContent).toContain('At least 8 characters.');

    await step(async () => {
      fill(container, 'invite-password', 'longenough');
      fill(container, 'invite-confirm', 'longenoughtoo');
      submit(container);
    });
    expect(alertText(container)).toBe('Passwords do not match');
    expect(auth.redeemInvite).not.toHaveBeenCalled();
  });

  it('states and asks the minimum the server publishes', async () => {
    authService.serverLimits.mockResolvedValue({ passwordMinLength: 12 });
    const { container, step } = await mount();
    expect(container.textContent).toContain('At least 12 characters.');
    await step(async () => {
      fill(container, 'invite-email', 'ada@example.com');
      fill(container, 'invite-password', 'longenough');
      fill(container, 'invite-confirm', 'longenough');
      submit(container);
    });
    expect(alertText(container)).toBe('Password must be at least 12 characters');
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
    authService.lookupInvite.mockResolvedValue({ status: 'active', kind: 'signup' });
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

  it('opens the project the invite joined', async () => {
    auth.redeemInvite.mockResolvedValue({ success: true, projectId: 'p1' });
    const { container, step } = await renderComponent(
      <MemoryRouter initialEntries={['/invite/CODE']}>
        <Routes>
          <Route
            path="/invite/:code"
            element={
              <RedeemInvite
                loginPath="/login"
                homePath="/projects"
                projectPath={(id) => `/projects/${id}/documents`}
              />
            }
          />
          <Route path="/projects" element={<p>the project list</p>} />
          <Route path="/projects/:projectId/documents" element={<p>the project p1</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await step(async () => {
      fill(container, 'invite-email', 'ada@example.com');
      fill(container, 'invite-password', 'longenough');
      fill(container, 'invite-confirm', 'longenough');
      submit(container);
    });
    expect(container.textContent).toBe('the project p1');
  });

  it('warns a signed-in reader what a link with no project does to their session', async () => {
    authService.lookupInvite.mockResolvedValue({ status: 'active', kind: 'signup' });
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

  // H1-3, Luke's ruling 2026-11-09: an existing account can take an invite.
  describe('with an account already', () => {
    const LoginProbe = () => {
      const location = useLocation();
      return <p id="login-from">{location.state?.from}</p>;
    };
    const routed = (entry = '/invite/CODE') =>
      renderComponent(
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route
              path="/invite/:code"
              element={
                <RedeemInvite
                  loginPath="/login"
                  homePath="/projects"
                  projectPath={(id) => `/projects/${id}/documents`}
                />
              }
            />
            <Route path="/login" element={<LoginProbe />} />
            <Route path="/projects" element={<p>the project list</p>} />
            <Route path="/projects/:projectId/documents" element={<p>the project p1</p>} />
          </Routes>
        </MemoryRouter>,
      );
    const signedIn = (accept) => {
      auth.user = { id: 'ada@example.com', displayName: 'Ada' };
      auth.client = { invites: { accept } };
    };

    it('offers sign-in to a reader who is signed out, and comes back here', async () => {
      const { container, step } = await routed();
      const link = byText(container, 'a', 'Sign in to join Lezgi');
      expect(link.getAttribute('href')).toBe('/login');
      await step(async () => link.click());
      expect(container.querySelector('#login-from').textContent).toBe('/invite/CODE');
    });

    it('says to sign in when the address has an account', async () => {
      auth.redeemInvite.mockResolvedValue({ success: false, status: 409 });
      const { container, step } = await mount();
      await step(async () => {
        fill(container, 'invite-email', 'ada@example.com');
        fill(container, 'invite-password', 'longenough');
        fill(container, 'invite-confirm', 'longenough');
        submit(container);
      });
      expect(alertText(container)).toBe(
        'An account already exists for that email address. Sign in to join Lezgi.',
      );
    });

    it('joins with one press when signed in, and opens the project', async () => {
      const accept = vi.fn(async () => ({ projectId: 'p1', projectRole: 'writer', joined: true }));
      signedIn(accept);
      const { container, step } = await routed();
      expect(container.querySelector('form')).toBe(null);
      expect(container.textContent).toContain('Signed in as Ada');
      expect(accept).not.toHaveBeenCalled();
      await step(async () => byText(container, 'button', 'Join Lezgi').click());
      expect(accept).toHaveBeenCalledWith('CODE');
      expect(notifySuccess).toHaveBeenCalledWith('Joined Lezgi as a writer.', 'Welcome');
      expect(container.textContent).toBe('the project p1');
    });

    it('joins straight away on the way back from sign-in', async () => {
      const accept = vi.fn(async () => ({ projectId: 'p1', projectRole: 'writer', joined: true }));
      signedIn(accept);
      const { container } = await renderComponent(
        <MemoryRouter initialEntries={[{ pathname: '/invite/CODE', state: { signedIn: true } }]}>
          <Routes>
            <Route
              path="/invite/:code"
              element={
                <RedeemInvite
                  loginPath="/login"
                  homePath="/projects"
                  projectPath={(id) => `/projects/${id}/documents`}
                />
              }
            />
            <Route path="/projects/:projectId/documents" element={<p>the project p1</p>} />
          </Routes>
        </MemoryRouter>,
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(accept).toHaveBeenCalledWith('CODE');
      expect(container.textContent).toBe('the project p1');
    });

    it('says why a link it could not use is dead', async () => {
      const accept = vi.fn(async () => {
        throw Object.assign(new Error('HTTP 410'), {
          status: 410,
          responseData: { status: 'used', error: 'That invite has already been used.' },
        });
      });
      signedIn(accept);
      const { container, step } = await routed();
      await step(async () => byText(container, 'button', 'Join Lezgi').click());
      expect(alertText(container)).toContain('This invite has already been used');
      expect(byText(container, 'a', 'Open Plaid IGT').getAttribute('href')).toBe('/projects');
    });

    // REV-FX-H1-1: Back from the project landed on the invite page, which
    // joined again and pushed the project again.
    it('leaves the history on a join, so Back does not join again', async () => {
      const accept = vi.fn(async () => ({ projectId: 'p1', projectRole: 'writer', joined: true }));
      signedIn(accept);
      let goBack;
      const Project = () => {
        goBack = useNavigate();
        return <p>the project p1</p>;
      };
      const { container, step } = await renderComponent(
        <MemoryRouter
          initialEntries={['/invite/CODE', { pathname: '/invite/CODE', state: { signedIn: true } }]}
          initialIndex={1}
        >
          <Routes>
            <Route
              path="/invite/:code"
              element={
                <RedeemInvite
                  loginPath="/login"
                  homePath="/projects"
                  projectPath={(id) => `/projects/${id}/documents`}
                />
              }
            />
            <Route path="/projects/:projectId/documents" element={<Project />} />
          </Routes>
        </MemoryRouter>,
      );
      await step(async () => new Promise((r) => setTimeout(r, 0)));
      expect(container.textContent).toBe('the project p1');
      await step(async () => goBack(-1));
      await step(async () => new Promise((r) => setTimeout(r, 0)));
      expect(accept).toHaveBeenCalledTimes(1);
      expect(byText(container, 'button', 'Join Lezgi')).not.toBe(null);
    });
  });
});
