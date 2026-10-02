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
// five are read at a glance down a column and "active" and "revoked" are the
// two that matter. "inactive" is a link whose creator no longer has the access
// it grants: dead for now, alive again if they get it back.
export const INVITE_STATUS_CLASS = {
  active: 'border-success/40 bg-success/10 text-success-foreground',
  used: 'border-border bg-muted text-muted-foreground',
  expired: 'border-border bg-muted text-muted-foreground',
  revoked: 'border-destructive/40 bg-destructive/10 text-destructive',
  inactive: 'border-warning/40 bg-warning/10 text-warning-foreground',
};

/** The hover text a status badge carries, where the word alone does not say it. */
export const INVITE_STATUS_TITLE = {
  inactive: 'Creator no longer has the access this link grants',
};

/** Whether a link can still be revoked: one that works, or one that could again. */
export const inviteRevocable = (status) => status === 'active' || status === 'inactive';

/** The three levels an invite can grant on a project, lowest first. */
export const GRANT_ROLES = ['reader', 'writer', 'maintainer'];

export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

/** A date as the reader's locale writes it, or nothing at all. */
export const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
};
