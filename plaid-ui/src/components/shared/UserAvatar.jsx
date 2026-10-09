import { useEffect, useState } from 'react';

import { Avatar, AvatarImage, AvatarFallback } from '../ui/avatar.jsx';
import { cn } from '../../lib/utils.js';
import { initials } from '../../lib/initials.js';
import { useSignInAgain } from '../../lib/signInAgain.js';

// The last URL each client resolved for a user and hash. An avatar that
// mounts again (a list re-rendered, a menu reopened) starts from it instead of
// from initials. The client keeps the token in it alive, and the effect below
// asks again anyway, so a renewed token replaces it.
const resolved = new WeakMap();

const lastUrl = (client, key) => resolved.get(client)?.get(key) ?? null;

const remember = (client, key, url) => {
  let urls = resolved.get(client);
  if (!urls) resolved.set(client, (urls = new Map()));
  urls.set(key, url);
};

/**
 * A user's profile picture, falling back to their initials.
 *
 * `avatarHash` comes straight off a user record. Passing it is what lets the
 * browser cache the image indefinitely and still pick up a change immediately,
 * so pass it whenever you have it. Omitting it still works, just with a short
 * cache window. When it is explicitly null the user has no picture and no
 * request is made at all.
 *
 * The URL comes from `client.users.avatarUrl`, which resolves once the
 * client holds an avatar token. Every avatar on a page shares that one token,
 * and the initials show until the URL arrives, and for good if it cannot.
 */
export function UserAvatar({
  client,
  userId,
  displayName,
  avatarHash,
  className,
  fallbackClassName,
  ...props
}) {
  const wanted = Boolean(client && userId && avatarHash !== null);
  const key = `${userId}\n${avatarHash ?? ''}`;
  const [answer, setAnswer] = useState(null);
  // The login the URL was resolved under. Signed out and in again in another
  // tab, the client takes the new login in place, and a picture that failed
  // under the old one is asked for again.
  // Read on every render, and a render comes with each new login in place.
  useSignInAgain();
  const login = typeof client?.token === 'string' ? client.token : null;
  // The URL that failed to load, once, so a new avatar token is asked for in
  // its place: the token dies with the login it was minted under. A second
  // failure is the picture's, and the initials stay.
  const [failed, setFailed] = useState(null);
  const renew = failed !== null && failed.key === key && failed.login === login;

  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    Promise.resolve()
      .then(() =>
        renew
          ? client.users.avatarUrl(userId, avatarHash, { renew: true })
          : client.users.avatarUrl(userId, avatarHash),
      )
      .then(
        (url) => {
          if (url) remember(client, key, url);
          if (live) setAnswer({ client, key, url: url ?? null });
        },
        () => {
          if (live) setAnswer({ client, key, url: null });
        },
      );
    return () => {
      live = false;
    };
  }, [wanted, client, userId, avatarHash, key, login, renew]);

  // An answer for other props is never shown, not even for the one render
  // before the effect above asks again.
  const src = !wanted
    ? null
    : answer && answer.client === client && answer.key === key
      ? answer.url
      : lastUrl(client, key);

  return (
    // `key` remounts the root whenever the picture changes or goes away. Radix
    // tracks image load status on the root and does NOT reset it when the
    // AvatarImage unmounts, so without this, removing your picture leaves the
    // status stuck at "loaded" and the fallback suppressed: an empty circle
    // where the initials belong.
    <Avatar key={src || 'initials'} className={cn('h-9 w-9', className)} {...props}>
      {src && (
        <AvatarImage
          src={src}
          alt=""
          onLoadingStatusChange={(status) => {
            if (status === 'error' && !renew) setFailed({ key, login });
          }}
        />
      )}
      {/* The initials do not scale with the avatar on their own, so anything
          much larger than the default needs to say so. */}
      <AvatarFallback className={cn('text-xs', fallbackClassName)}>
        {initials(displayName)}
      </AvatarFallback>
    </Avatar>
  );
}
