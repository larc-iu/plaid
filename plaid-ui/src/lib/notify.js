import { toast } from 'sonner';

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
// and node cannot resolve the `@ui` alias. Keep the behaviour identical.

// Many callers hand over a raw client `err.message`, which reads
// "HTTP 400 … at http://host/api/v1/…". Scrub the transport noise once, so no
// toast shows an internal URL.
const scrubTransport = (message) =>
  typeof message === 'string'
    ? message
        .replace(/\s*at\s+https?:\/\/\S+/gi, '')
        .replace(/^HTTP \d{3}\s*/i, '')
        .trim() || message
    : message;

export const notifySuccess = (message, title, options) =>
  toast.success(title || message, { ...(title ? { description: message } : {}), ...options });

export const notifyError = (message, title = 'Error', options) =>
  toast.error(title, { description: scrubTransport(message), ...options });

export const notifyWarning = (message, title = 'Warning', options) =>
  toast.warning(title, { description: message, ...options });

// Neither good news nor bad: a run someone stopped, a state that simply is.
export const notifyInfo = (message, title, options) =>
  toast(title || message, { ...(title ? { description: message } : {}), ...options });
