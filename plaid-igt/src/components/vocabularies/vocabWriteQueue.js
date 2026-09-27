import { WriteQueue } from '@ui/domain/WriteQueue.js';
import { notifyError } from '@/utils/feedback';

// The vocabulary screens' write queues report the way a document's do
// (plaid-ui DocumentModel): the edits a refusal kept from being sent are
// counted, and a refetch given up for good says the screen is out of date.

export const reportNotSent = (count) =>
  notifyError(
    count === 1 ? '1 later edit was not saved.' : `${count} later edits were not saved.`,
    'Not saved',
  );

export const vocabWriteQueue = () =>
  new WriteQueue({
    onOutOfStep: (err) => {
      console.error('The vocabulary could not be refetched:', err);
      notifyError('Reload the page to see what is saved.', 'Out of date');
    },
  });
