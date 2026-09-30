// A create made from a form: a document, a vocabulary, a guideline.
//
// The form names the id of what it makes (a UUIDv7) on its first press and
// keeps it until the create succeeds, so pressing again after an answer that
// never came sends the same id. The client already sends a write again under
// the same Idempotency-Key when its answer is lost. When even that gave up,
// the next press is answered 409 `id-taken` if the first landed, and that
// press opens what the first made instead of making a second.
//
// `ref` is where the form keeps the id between presses (a React ref, or any
// `{ current }`). `create(id)` makes the row under `id` and resolves to it.
// Resolves to what was made: the create's answer, or `{ id }` when an
// earlier press made it.
//
// Imports only errors.js and the client's ids.js, which import nothing, so
// the node suites can reach it by relative path.

import { isIdTaken } from './errors.js';
import { uuidv7 } from '../../../plaid-client-js/src/ids.js';

export async function createOnce(ref, create) {
  ref.current ??= uuidv7();
  const id = ref.current;
  let made;
  try {
    made = await create(id);
  } catch (err) {
    if (!isIdTaken(err)) throw err;
    made = { id };
  }
  ref.current = null;
  return made;
}
