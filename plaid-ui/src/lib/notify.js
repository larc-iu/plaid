import { toast } from 'sonner';
import { humanizeError } from './errors.js';

// The package's own toast primitives, for the screens that live here.
//
// Both apps have their own copy of this (`plaid-igt/src/utils/feedback.js`,
// `plaid-ud/src/utils/notify.js`) and a shared component cannot reach either:
// an app path is not importable from the package, and threading an `onError`
// prop through every screen that will move here (the comments browser, the
// service-run dialog, the assistant tab) is worse than one small module.
//
// They do not converge into one for a duller reason: plaid-ud's copy is
// imported by its domain layer, which its `node --test` suite loads directly,
// and node cannot resolve the `@ui` alias. All three route their error
// description through `errors.js`, which is what keeps them identical.

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
