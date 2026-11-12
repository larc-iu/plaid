// Whether the document's write lock is held by the run named `label`: the run
// an opener starts, whichever page or hook started it (a run rejoined after a
// reload holds it under the name it was started with). Its opener then shows
// the run as going and cannot open the dialog again, since the banner over the
// document shows the run and has its Stop.
export const heldBy = (writeLock, label) => !!writeLock && writeLock.label === label;

// What a service dialog says while another run holds the document: the run
// that holds it, and that only one runs at a time. Null when nothing holds it.
export const runHeldNotice = (writeLock) =>
  writeLock ? `${writeLock.label} is running. One run at a time on a document.` : null;
