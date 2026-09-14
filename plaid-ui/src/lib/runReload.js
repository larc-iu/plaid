import { notifyWarning } from './notify.js';

// Re-reading a document after a service run, when the run has already been
// reported as finished.
//
// The failure this exists for is quiet: the service wrote, the success toast
// has been shown, the reload throws, and the screen goes on showing pre-run
// data with nothing to say what happened. Every caller used to swallow the
// throw into the same catch as the request's own, which then either said
// nothing (the run had already toasted) or called the run itself a failure.
//
// The run did not fail, so this does not say it did. Returns whether the
// document came back, for a caller that has something else to decide.
export const reloadAfterRun = async (reload) => {
  try {
    await reload();
    return true;
  } catch (error) {
    console.error('Could not reload after a service run:', error);
    notifyWarning(
      'The run finished but the document could not be reloaded. Reload the page to see it.',
      'Results not shown',
    );
    return false;
  }
};
