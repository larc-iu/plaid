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

// Neither good news nor bad: a run someone stopped, a state that simply is.
export const notifyInfo = (message, title, options) =>
  toast(title || message, { ...(title ? { description: message } : {}), ...options });

// A toast for work in flight, updated in place when the promise settles.
// `success` and `error` may be strings or functions of the settled value.
//
// Returns the promise it was given, not sonner's toast id: callers chain off
// it (`.catch(() => {})` where the failure is already on screen as this toast
// and must not surface a second time as an unhandled rejection).
export const notifyPromise = (promise, { loading, success, error }) => {
  toast.promise(promise, { loading, success, error });
  return promise;
};

// A toast carrying a single action button. sonner dismisses it on click.
// `kind` picks the variant, and a `duration` of Infinity makes it stick.
export const notifyWithAction = (
  message,
  title,
  { label, onClick, kind = 'success', duration = 15000 },
) => {
  const show = { success: toast.success, warning: toast.warning, error: toast.error }[kind];
  return show(title || message, {
    ...(title ? { description: message } : {}),
    duration,
    action: { label, onClick },
  });
};
