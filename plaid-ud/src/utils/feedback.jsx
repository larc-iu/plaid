import { toast } from 'sonner';

// App-wide feedback primitives. Transient outcomes are toasts; destructive
// actions go through the shared ConfirmProvider (`useConfirm`), mounted once in
// main.jsx. The toast functions live in notify.js (JSX-free, importable from
// node); re-exported here so components keep one import site.
export { notifySuccess, notifyError, notifyWarning } from './notify.js';

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
