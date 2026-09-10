import PlaidClient from '@larc-iu/plaid-client';

// The link a redeemer opens: this app's own origin and path, with the code.
export const inviteLinkFor = (code) => {
  const { origin, pathname } = window.location;
  return PlaidClient.inviteUrl(`${origin}${pathname}`, code);
};
