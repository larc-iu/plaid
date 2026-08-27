import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

// Initials fallback for a user with no picture. Two words give two letters
// ("Ada Lovelace" -> AL); anything else gives one. Usernames here are often
// email addresses, so strip the domain first or every avatar in a roster from
// the same institution would read the same.
export function userInitials(username) {
  if (!username) return '?';
  const local = username.split('@')[0];
  const words = local.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return username.charAt(0).toUpperCase();
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
}

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
  username,
  avatarHash,
  className,
  fallbackClassName,
  ...props
}) {
  const src = client && userId ? client.users.avatarUrl(userId, avatarHash) : null;

  return (
    <Avatar className={cn('h-9 w-9', className)} {...props}>
      {src && <AvatarImage src={src} alt="" />}
      {/* The initials do not scale with the avatar on their own, so anything
          much larger than the default needs to say so. */}
      <AvatarFallback className={cn('text-xs', fallbackClassName)}>
        {userInitials(username)}
      </AvatarFallback>
    </Avatar>
  );
}
