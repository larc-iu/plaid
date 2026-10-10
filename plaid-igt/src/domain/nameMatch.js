import { nameKey } from '@ui/lib/nameKey.js';

/**
 * Whether two names are the same name to a person reading a list: the same
 * after composing (NFC, as the server stores a name) and ignoring case.
 */
export const sameNameIgnoringCase = (a, b) => nameKey(a).toLowerCase() === nameKey(b).toLowerCase();
