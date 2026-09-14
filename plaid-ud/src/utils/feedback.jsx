// App-wide feedback primitives. Transient outcomes are toasts; destructive
// actions go through the shared ConfirmProvider (`useConfirm`), mounted once in
// main.jsx. The toast functions live in notify.js (JSX-free, importable from
// node); re-exported here so components keep one import site.
export {
  notifySuccess,
  notifyError,
  notifyInfo,
  notifyWarning,
  notifyPromise,
  notifyWithAction,
} from './notify.js';

// The error vocabulary is shared with plaid-igt through plaid-ui, and
// re-exported here so this file stays the one import a screen needs: a screen
// with the error object in hand passes it through `humanizeError` so its
// status is read, rather than handing over a raw `err.message`.
export { humanizeError } from '@ui/lib/errors.js';
