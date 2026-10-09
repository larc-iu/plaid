import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaidClient } from '@larc-iu/plaid-client';

import { renderComponent } from '../../test/renderComponent.jsx';
import { UserAvatar } from './UserAvatar.jsx';
import { signedInAgain } from '../../lib/signInAgain.js';

// Radix shows the image only once the browser says it loaded, which the test
// DOM never does. This one loads every picture at once.
class LoadedImage {
  complete = true;
  naturalWidth = 1;
  addEventListener() {}
  removeEventListener() {}
}

// A browser that fails every picture whose URL names a dead token, after the
// moment a real load takes, and loads the rest.
class DeadTokenImage {
  complete = false;
  naturalWidth = 0;
  addEventListener(type, cb) {
    setTimeout(() => {
      const dead = String(this.src).includes('dead');
      if (type === 'error' && dead) cb({ currentTarget: this });
      if (type === 'load' && !dead) {
        this.complete = true;
        this.naturalWidth = 1;
        cb({ currentTarget: this });
      }
    }, 0);
  }
  removeEventListener() {}
}

const img = (container) => container.querySelector('img');
const fallback = (container) => container.textContent;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('UserAvatar', () => {
  let realImage;
  beforeEach(() => {
    realImage = window.Image;
    window.Image = LoadedImage;
  });
  afterEach(() => {
    window.Image = realImage;
    vi.restoreAllMocks();
  });

  it('shows the initials until the URL arrives, then the picture', async () => {
    const pending = deferred();
    const client = { users: { avatarUrl: vi.fn(() => pending.promise) } };
    const r = await renderComponent(
      <UserAvatar client={client} userId="ada@x.org" displayName="Ada Lovelace" avatarHash="h1" />,
    );
    expect(img(r.container)).toBeNull();
    expect(fallback(r.container)).toBe('AL');
    expect(client.users.avatarUrl).toHaveBeenCalledWith('ada@x.org', 'h1');
    await r.step(() =>
      pending.resolve('http://core/api/v1/users/ada@x.org/avatar?avatar-token=t&v=h1'),
    );
    expect(img(r.container)?.getAttribute('src')).toBe(
      'http://core/api/v1/users/ada@x.org/avatar?avatar-token=t&v=h1',
    );
    await r.unmount();
  });

  it('asks for nothing when the user has no picture', async () => {
    const client = { users: { avatarUrl: vi.fn() } };
    const r = await renderComponent(
      <UserAvatar
        client={client}
        userId="ada@x.org"
        displayName="Ada Lovelace"
        avatarHash={null}
      />,
    );
    expect(client.users.avatarUrl).not.toHaveBeenCalled();
    expect(img(r.container)).toBeNull();
    expect(fallback(r.container)).toBe('AL');
    await r.unmount();
  });

  it('keeps the initials when the URL cannot be had', async () => {
    const client = { users: { avatarUrl: vi.fn(() => Promise.reject(new Error('401'))) } };
    const r = await renderComponent(
      <UserAvatar client={client} userId="bob@x.org" displayName="Bob Ross" avatarHash="h1" />,
    );
    await r.step(async () => {});
    expect(img(r.container)).toBeNull();
    expect(fallback(r.container)).toBe('BR');
    await r.unmount();
  });

  it('never shows the previous user’s picture for a new one', async () => {
    const answers = { 'a@x.org': deferred(), 'b@x.org': deferred() };
    const client = { users: { avatarUrl: vi.fn((id) => answers[id].promise) } };
    const r = await renderComponent(
      <UserAvatar client={client} userId="a@x.org" displayName="A A" avatarHash="ha" />,
    );
    await r.step(() => answers['a@x.org'].resolve('http://core/a'));
    expect(img(r.container)?.getAttribute('src')).toBe('http://core/a');
    await r.rerender(
      <UserAvatar client={client} userId="b@x.org" displayName="B B" avatarHash="hb" />,
    );
    expect(img(r.container)).toBeNull();
    expect(fallback(r.container)).toBe('BB');
    await r.step(() => answers['b@x.org'].resolve('http://core/b'));
    expect(img(r.container)?.getAttribute('src')).toBe('http://core/b');
    await r.unmount();
  });

  it('shares one token among every avatar on the page, and keeps the login token out', async () => {
    const calls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(
        JSON.stringify({
          token: 'av1',
          'expires-at': new Date(Date.now() + 86400e3).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new PlaidClient('http://core', 'login-secret');
    const users = ['a', 'b', 'c', 'd', 'e'].map((n) => `${n}@x.org`);
    const r = await renderComponent(
      <div>
        {users.map((id) => (
          <UserAvatar
            key={id}
            client={client}
            userId={id}
            displayName={id}
            avatarHash={`h-${id.charAt(0)}`}
          />
        ))}
      </div>,
    );
    await r.step(async () => {});
    expect(calls).toEqual([{ url: 'http://core/api/v1/avatar-link', method: 'POST' }]);
    const srcs = [...r.container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toEqual(
      users.map(
        (id) => `http://core/api/v1/users/${id}/avatar?avatar-token=av1&v=h-${id.charAt(0)}`,
      ),
    );
    expect(srcs.some((s) => s.includes('login-secret'))).toBe(false);
    await r.unmount();
  });

  it('starts from the last URL when it mounts again', async () => {
    const client = { users: { avatarUrl: vi.fn(async () => 'http://core/c') } };
    const first = await renderComponent(
      <UserAvatar client={client} userId="c@x.org" displayName="C C" avatarHash="hc" />,
    );
    await first.step(async () => {});
    await first.unmount();
    client.users.avatarUrl.mockImplementation(() => new Promise(() => {}));
    const again = await renderComponent(
      <UserAvatar client={client} userId="c@x.org" displayName="C C" avatarHash="hc" />,
    );
    expect(img(again.container)?.getAttribute('src')).toBe('http://core/c');
    await again.unmount();
  });

  it('asks once for a new token when the picture fails, and shows it', async () => {
    window.Image = DeadTokenImage;
    const client = {
      token: 'login',
      users: {
        avatarUrl: vi.fn(async (id, hash, options) =>
          options?.renew
            ? `http://core/a?avatar-token=fresh&v=${hash}`
            : `http://core/a?avatar-token=dead&v=${hash}`,
        ),
      },
    };
    const r = await renderComponent(
      <UserAvatar client={client} userId="ada@x.org" displayName="Ada Lovelace" avatarHash="h1" />,
    );
    for (let i = 0; i < 4; i += 1) await r.step(() => new Promise((res) => setTimeout(res, 5)));
    expect(client.users.avatarUrl).toHaveBeenLastCalledWith('ada@x.org', 'h1', { renew: true });
    expect(img(r.container)?.getAttribute('src')).toBe('http://core/a?avatar-token=fresh&v=h1');
    await r.unmount();
  });

  it('a picture that fails with a new token too keeps the initials, and asks no more', async () => {
    window.Image = DeadTokenImage;
    const client = {
      token: 'login',
      users: { avatarUrl: vi.fn(async () => 'http://core/a?avatar-token=dead') },
    };
    const r = await renderComponent(
      <UserAvatar client={client} userId="ada@x.org" displayName="Ada Lovelace" avatarHash="h1" />,
    );
    for (let i = 0; i < 6; i += 1) await r.step(() => new Promise((res) => setTimeout(res, 5)));
    expect(client.users.avatarUrl).toHaveBeenCalledTimes(2);
    expect(img(r.container)).toBeNull();
    expect(fallback(r.container)).toBe('AL');
    await r.unmount();
  });

  it('asks again when the client takes another login', async () => {
    const client = {
      token: 'login-1',
      users: { avatarUrl: vi.fn(async () => `http://core/a?avatar-token=for-${client.token}`) },
    };
    const view = (
      <UserAvatar client={client} userId="ada@x.org" displayName="Ada Lovelace" avatarHash="h1" />
    );
    const r = await renderComponent(view);
    await r.step(async () => {});
    client.token = 'login-2';
    await r.rerender(
      <UserAvatar client={client} userId="ada@x.org" displayName="Ada Lovelace" avatarHash="h1" />,
    );
    await r.step(async () => {});
    expect(client.users.avatarUrl).toHaveBeenCalledTimes(2);
    expect(img(r.container)?.getAttribute('src')).toBe('http://core/a?avatar-token=for-login-2');
    await r.unmount();
  });

  it('asks again when another tab signs this one back in, with no other render', async () => {
    const client = {
      token: 'login-1',
      users: { avatarUrl: vi.fn(async () => `http://core/a?avatar-token=for-${client.token}`) },
    };
    const r = await renderComponent(
      <UserAvatar client={client} userId="ada@x.org" displayName="Ada Lovelace" avatarHash="h1" />,
    );
    await r.step(async () => {});
    // What services/auth.js does on taking a login in place.
    await r.step(async () => {
      client.token = 'login-2';
      signedInAgain();
    });
    await r.step(async () => {});
    expect(img(r.container)?.getAttribute('src')).toBe('http://core/a?avatar-token=for-login-2');
    await r.unmount();
  });
});
