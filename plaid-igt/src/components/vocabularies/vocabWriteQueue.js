import { WriteQueue } from '@ui/domain/WriteQueue.js';
import { notifyError } from '@/utils/feedback';

// The vocabulary screens' write queues report the way a document's do
// (plaid-ui DocumentModel): a refetch given up for good says the screen is out
// of date.

export const vocabWriteQueue = () =>
  new WriteQueue({
    onOutOfStep: (err) => {
      console.error('The vocabulary could not be refetched:', err);
      notifyError('Reload the page to see what is saved.', 'Out of date');
    },
  });
