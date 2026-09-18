// App-wide feedback primitives. Transient outcomes are toasts; destructive
// actions go through the shared ConfirmProvider (`useConfirm`), mounted once in
// main.jsx. The toast functions are the shared package's, re-exported here so
// components keep one import site. The domain layer never imports this: a
// ConlluDocument reports through its `onError`, which the shell wires.
export {
  notifySuccess,
  notifyError,
  notifyInfo,
  notifyWarning,
  notifyPromise,
  notifyWithAction,
} from '@ui/lib/notify.js';

// The error vocabulary is shared with plaid-igt through plaid-ui, and
// re-exported here so this file stays the one import a screen needs: a screen
// with the error object in hand passes it through `humanizeError` so its
// status is read, rather than handing over a raw `err.message`.
export { humanizeError } from '@ui/lib/errors.js';
