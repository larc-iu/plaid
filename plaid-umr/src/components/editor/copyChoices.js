import { notifyError } from '@ui/lib/notify.js';
import { humanizeError } from '@ui/lib/errors.js';
import { copyTextOnly, CopyKeptGraphs } from '../../domain/textOnlyCopy.js';

// What the Details tab's Copy offers in plaid-umr: the whole document, or its
// text alone for a second annotator (the owner's ruling umr-collab-blank-copy).
// The shape is the shared page's `copyChoices` (DocumentDetailsPage.jsx).
export const UMR_COPY_CHOICES = [
  { value: 'all', label: 'Text and UMR graphs' },
  {
    value: 'text',
    label: 'Text only',
    hint: 'Words and glosses, without the UMR graphs.',
    copy: async ({ client, doc, name }) => {
      try {
        return await copyTextOnly(client, doc, name);
      } catch (error) {
        // The copy with its graphs could not be deleted: the page stays
        // here instead of opening it, and the toast stays until closed.
        if (error instanceof CopyKeptGraphs) {
          notifyError(
            `Delete “${error.created.name}” before copying again.`,
            `Copied to “${error.created.name}” with its UMR graphs`,
            { duration: Infinity },
          );
          return { ...error.created, notified: true, stay: true };
        }
        notifyError(humanizeError(error), 'Failed to copy document');
        return null;
      }
    },
  },
];
