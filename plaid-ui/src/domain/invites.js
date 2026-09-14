import PlaidClient from '@larc-iu/plaid-client';

// The link a redeemer opens: the minting app's own origin and path, with the
// code. The server never learns the app's public URL, so the app that minted
// the invite is the one that names it, and `window.location` is authoritative
// here in a way no server config could be: it is literally where this user is.
export const inviteLinkFor = (code) => {
  const { origin, pathname } = window.location;
  return PlaidClient.inviteUrl(`${origin}${pathname}`, code);
};

// What each status looks like. Colour rather than a shadcn variant, because the
// four are read at a glance down a column and "active" and "revoked" are the
// two that matter.
export const INVITE_STATUS_CLASS = {
  active: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
  used: 'border-border bg-muted text-muted-foreground',
  expired: 'border-border bg-muted text-muted-foreground',
  revoked: 'border-destructive/40 bg-destructive/10 text-destructive',
};

/** The three levels an invite can grant on a project, lowest first. */
export const GRANT_ROLES = ['reader', 'writer', 'maintainer'];

export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

/** A date as the reader's locale writes it, or nothing at all. */
export const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
};
