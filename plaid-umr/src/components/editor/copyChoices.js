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
        if (error instanceof CopyKeptGraphs) {
          notifyError(
            humanizeError(error.cause),
            `Copied to “${error.created.name}” with its UMR graphs`,
          );
          return { ...error.created, notified: true };
        }
        notifyError(humanizeError(error), 'Failed to copy document');
        return null;
      }
    },
  },
];
