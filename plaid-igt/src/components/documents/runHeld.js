// What a service dialog says while another run holds the document: the run
// that holds it, and that only one runs at a time. The same words as ud's and
// umr's dialogs. Null when nothing else holds it.
export const runHeldNotice = (writeLock, running) =>
  writeLock && !running ? `${writeLock.label} is running. One run at a time on a document.` : null;
