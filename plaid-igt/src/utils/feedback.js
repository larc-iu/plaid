import { toast } from 'sonner';

// The one import every screen in this app uses for feedback. The toasts
// themselves are the package's, so both apps say the same thing in the same
// words and every error description goes through `humanizeError`. Transient
// outcomes are toasts; destructive confirms go through the shadcn
// <AlertDialog> component, not here.
export { notifySuccess, notifyError, notifyInfo, notifyWarning } from '@ui/lib/notify.js';
export { humanizeError, isPermissionError } from '@ui/lib/errors.js';

// A toast that follows a promise: `loading` while it runs, then `success`
// (a string, or a function of the result) or `error` (a function of the
// error).
export const notifyPromise = (promise, { loading, success, error }) =>
  toast.promise(promise, { loading, success, error });
