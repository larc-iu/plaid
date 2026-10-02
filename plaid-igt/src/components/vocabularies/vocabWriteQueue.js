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

// Several queues seen as one, in the shape plaid-ui's SaveStatus watches: it
// is saving while any of them is, and retrying while any of them is retrying
// a send of its own.
export const queuesStatus = (...queues) => {
  const saving = () => queues.some((q) => q.isSaving);
  const offline = () => queues.some((q) => q.isSaving && q.isOffline);
  return {
    subscribe: (fn) => {
      const offs = queues.map((q) => q.subscribe(fn));
      return () => offs.forEach((off) => off());
    },
    getSnapshot: () => `${saving()}:${offline()}`,
    get isSaving() {
      return saving();
    },
    get isOffline() {
      return offline();
    },
  };
};
