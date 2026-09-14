import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { renderComponent } from '../../test/renderComponent.jsx';
import { UserButton } from './UserButton.jsx';

const user = { id: 'a@b.com', displayName: 'Ada', avatarHash: null };
const client = { users: { avatarUrl: () => null } };

const open = async (props = {}) => {
  const r = await renderComponent(
    <MemoryRouter>
      <UserButton user={user} client={client} onLogout={props.onLogout ?? vi.fn()} {...props} />
    </MemoryRouter>,
  );
  const trigger = r.container.querySelector('button');
  await r.step(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    trigger.click();
  });
  return r;
};

const profileLink = () =>
  [...document.querySelectorAll('a')].find((a) => /Profile/.test(a.textContent));
const logoutItem = () =>
  [...document.querySelectorAll('[role="menuitem"]')].find((n) => /Logout/.test(n.textContent));

describe('UserButton', () => {
  it('points Profile where the app says, since a route is not the package\u2019s', async () => {
    const r = await open({ profileHref: '/profile' });
    expect(profileLink()?.getAttribute('href')).toBe('/profile');
    await r.unmount();
  });

  it('takes the account page from the app that has one elsewhere', async () => {
    const r = await open({ profileHref: '/me' });
    expect(profileLink()?.getAttribute('href')).toBe('/me');
    await r.unmount();
  });

  it('logs out with no argument, so a click event is never read as a reason', async () => {
    // logout takes an optional reason shown on the login page, and passing the
    // handler straight to onClick sent the click event in as one.
    const onLogout = vi.fn();
    const r = await open({ onLogout });
    await r.step(async () => logoutItem()?.click());
    expect(onLogout).toHaveBeenCalledWith();
    await r.unmount();
  });
});
