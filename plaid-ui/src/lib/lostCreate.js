// A create whose answer never came back (errors.js `isUnknownOutcome`) may
// have made the record. Pressing Create again would then make a second one,
// so a screen reads its list again first and opens what the create made.
//
// `before` is the list as it was before the create, `reread()` reads it
// again, and `isIt(row)` says whether a row is the one asked for (its name).
// Resolves to the row the create made, or null: when the answer was not
// lost, when the list before is unknown (a row of that name may have been
// there already), when the list could not be read, or when nothing new is
// there.
//
// Imports only errors.js, which imports nothing, so the node suites can reach
// it by relative path.

import { isUnknownOutcome } from './errors.js';

export async function findLostCreate(err, { before, reread, isIt }) {
  if (!isUnknownOutcome(err) || !Array.isArray(before)) return null;
  const known = new Set(before.map((row) => row.id));
  let now;
  try {
    now = await reread();
  } catch (readErr) {
    console.error('Could not read the list again after a lost answer:', readErr);
    return null;
  }
  return (now || []).find((row) => !known.has(row.id) && isIt(row)) ?? null;
}
