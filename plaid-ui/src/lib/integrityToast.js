import { toast } from 'sonner';

import { appName } from './uiConfig.js';

// Saying that a loaded document did not come back the way it should have.
//
// Full detail to the console, grouped, plus ONE consolidated toast with a Copy
// details action that drops the lot onto the clipboard for a bug report.
// Findings are what the app could NOT repair, which is exactly why they are
// worth interrupting for. Repairs that SUCCEEDED say nothing.
//
// One toast id, so a document that reloads under a failing check replaces its
// own notice rather than stacking them. It never expires: an unrepaired
// document is a standing fact, not an event.

const TOAST_ID = 'plaid-integrity-findings';

/**
 * The findings as one line each, machine-pasteable into a bug report.
 */
export const formatFindingsForClipboard = (findings, { documentId } = {}) => {
  const header = documentId
    ? `Document integrity findings (document ${documentId})`
    : 'Document integrity findings';
  const lines = (findings || []).map(
    (f) => `[${f.severity}] ${f.code}: ${f.message} ${JSON.stringify(f.context || {})}`,
  );
  return [header, ...lines].join('\n');
};

export const reportIntegrityFindings = (findings, { documentId } = {}) => {
  if (!findings?.length) return;

  console.group(`[${appName()}] Document integrity findings (${findings.length})`);
  findings.forEach((f) =>
    (f.severity === 'error' ? console.error : console.warn)(`[${f.code}] ${f.message}`, f.context),
  );
  console.groupEnd();

  // Errors speak for the batch when there are any: a warning alongside them is
  // not what the reader needs to hear first.
  const errors = findings.filter((f) => f.severity === 'error');
  const headline = errors.length ? errors : findings;
  const reason =
    headline.length === 1
      ? headline[0].message
      : `${headline.length} issues found. The browser console has the details.`;
  const detail = formatFindingsForClipboard(findings, { documentId });

  const show = errors.length ? toast.error : toast.warning;
  show('Data integrity issue detected', {
    id: TOAST_ID,
    description: reason,
    duration: Infinity,
    action: {
      label: 'Copy details',
      onClick: () => navigator.clipboard?.writeText(detail).catch(() => {}),
    },
  });
};

/**
 * Drop the notice. It is sticky, so that it is not missed, but it is about ONE
 * document: a screen that leaves for another clears it rather than letting it
 * follow the reader around the app.
 */
export const dismissIntegrityFindings = () => toast.dismiss(TOAST_ID);
