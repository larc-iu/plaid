// The letters an avatar chip shows for someone with no picture.
//
// One rule, because the same person appears as a chip in several places and a
// roster where the comment thread says AL and the members table says AE is a
// roster of strangers. A display name is usually a person's name, but falls
// back to their id, which is an email address, so the domain goes first: every
// avatar in an institution would otherwise read the same two letters.

export const initials = (name) => {
  const parts = String(name || '')
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};
