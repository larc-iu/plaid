// Usernames in Plaid ARE email addresses. The server is the authority
// (`plaid.sql.user/assert-valid-username!`); this mirrors its rule only so the
// person typing hears about a typo before a round trip.
//
// Deliberately the SAME permissive shape as the server's regex rather than
// something stricter. A client check that rejects an address the server would
// accept is worse than no check at all: it locks someone out of their own
// signup with no way to argue.
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const isEmail = (value) => EMAIL_PATTERN.test((value ?? '').trim());

// One wording everywhere, so the rule reads the same at whichever form you
// happen to meet it.
export const EMAIL_REQUIRED_MESSAGE = 'Enter an email address';
export const EMAIL_INVALID_MESSAGE = 'That does not look like an email address';
