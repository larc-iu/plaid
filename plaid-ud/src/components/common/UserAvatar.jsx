import { Avatar } from '@mantine/core';

// Initials fallback for a user with no picture. Two words give two letters
// ("Ada Lovelace" -> AL); anything else gives one. Usernames here are often
// email addresses, so strip the domain first or every avatar in a roster from
// the same institution would read the same.
export const userInitials = (username) => {
  if (!username) return '?';
  const local = username.split('@')[0];
  const words = local.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return username.charAt(0).toUpperCase();
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
};

/**
 * A user's profile picture, falling back to their initials.
 *
 * Distinct from `EntityAvatar`, which draws a deterministic glyph for a UUID:
 * this one shows an actual picture a person uploaded, and only falls back to
 * something generated when they haven't.
 *
 * `avatarHash` comes straight off a user record. Passing it is what lets the
 * browser cache the image indefinitely and still pick up a change immediately,
 * so pass it whenever you have it. When it is explicitly null the user has no
 * picture and no request is made at all.
 */
export const UserAvatar = ({ client, userId, username, avatarHash, size = 28, ...props }) => {
  const src = client && userId ? client.users.avatarUrl(userId, avatarHash) : null;
  return (
    <Avatar src={src} alt="" size={size} radius="xl" color="blue" {...props}>
      {userInitials(username)}
    </Avatar>
  );
};
