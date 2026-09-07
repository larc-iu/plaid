import { toast } from 'sonner';

// Transient outcomes are toasts (sonner). Signature matches plaid-igt's.

export const notifySuccess = (message, title, options) =>
  toast.success(title || message, { ...(title ? { description: message } : {}), ...options });

// Client errors arrive as "HTTP 400 … at http://host/api/v1/…". Scrub the
// transport noise centrally so no toast shows an internal URL.
const scrubTransport = (message) =>
  typeof message === 'string'
    ? message
        .replace(/\s*at\s+https?:\/\/\S+/gi, '')
        .replace(/^HTTP \d{3}\s*/i, '')
        .trim() || message
    : message;

export const notifyError = (message, title = 'Error', options) =>
  toast.error(title, { description: scrubTransport(message), ...options });
