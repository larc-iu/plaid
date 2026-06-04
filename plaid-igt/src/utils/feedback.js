import { toast } from 'sonner';

// App-wide feedback primitives (sonner-backed). Transient outcomes are toasts.
// Signature mirrors plaid-ud's feedback util: (message, title?).
// Destructive confirms go through the shadcn <AlertDialog> component, not here.

export const notifySuccess = (message, title) =>
  toast.success(title || message, title ? { description: message } : undefined);

export const notifyError = (message, title = 'Error') =>
  toast.error(title, { description: message });

export const notifyInfo = (message, title) =>
  toast(title || message, title ? { description: message } : undefined);

export const notifyWarning = (message, title = 'Warning') =>
  toast.warning(title, { description: message });

// Re-export the raw toast for advanced cases (promise toasts, custom JSX, etc.).
export { toast };
