import { toast } from 'sonner';
import { humanizeError } from './errors.js';

// The package's own toast primitives, for the screens that live here, and for
// plaid-igt, whose `utils/feedback.js` re-exports them.
//
// plaid-ud keeps a copy (`src/utils/notify.js`) for one reason: its domain
// layer imports it, its `node --test` suite loads that directly, and there
// neither the `@ui` alias nor this file's own `sonner` import resolves. Both
// route their error description through `errors.js`, which is what keeps the
// wording identical.

export const notifySuccess = (message, title, options) =>
  toast.success(title || message, { ...(title ? { description: message } : {}), ...options });

// Callers hand over either a client error or a message. `humanizeError` reads
// the status off the object where there is one, and parses it back out of the
// message where there is not, so a status reads as one sentence in every app
// and no toast shows an internal URL or a bare id.
export const notifyError = (message, title = 'Error', options) =>
  toast.error(title, { description: humanizeError(message), ...options });

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
