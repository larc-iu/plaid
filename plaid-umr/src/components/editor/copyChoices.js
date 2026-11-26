import { notifyError } from '@ui/lib/notify.js';
import { humanizeError } from '@ui/lib/errors.js';
import { t } from '@ui/lib/i18n.js';
import { copyTextOnly, CopyKeptGraphs } from '../../domain/textOnlyCopy.js';

// What the Details tab's Copy offers in plaid-umr: the whole document, or its
// text alone for a second annotator (the owner's ruling umr-collab-blank-copy).
// The shape is the shared page's `copyChoices` (DocumentDetailsPage.jsx),
// which shows `label` and `hint` as given: getters, so each is read in the
// page's language when the dialog draws it.
export const UMR_COPY_CHOICES = [
  {
    value: 'all',
    get label() {
      return t('Text and UMR graphs');
    },
  },
  {
    value: 'text',
    get label() {
      return t('Text only');
    },
    get hint() {
      return t('Words and glosses, without the UMR graphs.');
    },
    copy: async ({ client, doc, name, onNameTaken }) => {
      try {
        return await copyTextOnly(client, doc, name, { onNameTaken });
      } catch (error) {
        // The copy with its graphs could not be deleted: the page stays
        // here instead of opening it, and the toast stays until closed.
        if (error instanceof CopyKeptGraphs) {
          notifyError(
            t('Delete “{name}” before copying again.', { name: error.created.name }),
            t('Copied to “{name}” with its UMR graphs', { name: error.created.name }),
            { duration: Infinity },
          );
          return { ...error.created, notified: true, stay: true };
        }
        notifyError(humanizeError(error), t('Failed to copy document'));
        return null;
      }
    },
  },
];
