import { Avatar, AvatarImage, AvatarFallback } from '../ui/avatar.jsx';
import { cn } from '../../lib/utils.js';
import { initials } from '../../lib/initials.js';

/**
 * A user's profile picture, falling back to their initials.
 *
 * `avatarHash` comes straight off a user record. Passing it is what lets the
 * browser cache the image indefinitely and still pick up a change immediately,
 * so pass it whenever you have it. Omitting it still works, just with a short
 * cache window. When it is explicitly null the user has no picture and no
 * request is made at all.
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
  const src = client && userId ? client.users.avatarUrl(userId, avatarHash) : null;

  return (
    // `key` remounts the root whenever the picture changes or goes away. Radix
    // tracks image load status on the root and does NOT reset it when the
    // AvatarImage unmounts, so without this, removing your picture leaves the
    // status stuck at "loaded" and the fallback suppressed: an empty circle
    // where the initials belong.
    <Avatar key={src || 'initials'} className={cn('h-9 w-9', className)} {...props}>
      {src && <AvatarImage src={src} alt="" />}
      {/* The initials do not scale with the avatar on their own, so anything
          much larger than the default needs to say so. */}
      <AvatarFallback className={cn('text-xs', fallbackClassName)}>
        {initials(displayName)}
      </AvatarFallback>
    </Avatar>
  );
}
