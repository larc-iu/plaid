// The one sentence a broken or half-finished project setup shows on screen.
// A guard that finds a piece of the setup missing (a layer, a role binding)
// names that piece only in the console, since the person who sees the toast
// cannot act on a layer name and a maintainer finishes setup the same way
// whatever is missing.
export const NOT_SET_UP =
  'This project is not fully set up. A project maintainer can finish setup.';

// Logs what exactly is missing and returns the on-screen sentence, for
// `this.setError(notSetUp('Morpheme layer not configured'))`.
export function notSetUp(detail) {
  console.error(`Project setup incomplete: ${detail}`);
  return NOT_SET_UP;
}
