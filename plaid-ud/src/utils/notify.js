import { toast } from 'sonner';
import { humanizeError } from '../../../plaid-ui/src/lib/errors.js';

// Toast primitives, kept JSX-free so non-UI modules (the ConlluDocument
// domain layer, and node-run tests) can import them without a JSX loader.
// Components usually import these via feedback.jsx, which re-exports them
// alongside the confirm helper.
//
// The error wording is the shared package's: `humanizeError` is the one
// implementation of "turn a client or HTTP error into something a person should
// read", so an error reads the same in every app and no toast ever shows an
// internal URL or a bare id. It is imported by its real path rather than
// through `@ui` because this file is loaded by the `node --test` suite, where
// no alias exists: it is the same file `@ui/lib/errors.js` resolves to, and it
// imports nothing itself, which is what lets node load it. The package's
// notify.js cannot be re-exported here for that reason alone, it imports
// sonner, which does not resolve from the package's own directory.
//
// Call sites still pass the error OBJECT through `humanizeError` themselves
// where they have one, so its status is read rather than parsed back out of a
// message. Running it twice changes nothing.
//
// `options` is passed straight to sonner. The one worth knowing is
// `duration: Infinity`, which makes a notice stick until dismissed.

export const notifySuccess = (message, title, options) =>
  toast.success(title || message, { ...(title ? { description: message } : {}), ...options });

export const notifyError = (message, title = 'Error', options) =>
  toast.error(title, { description: humanizeError(message), ...options });

// A loud, non-error notice (e.g. an automatic repair the user should review).
export const notifyWarning = (message, title = 'Warning', options) =>
  toast.warning(title, { description: message, ...options });
