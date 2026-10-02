// The resend loop of a text save: the edits typed, planned as gaps over a body
// whose digest the server issued, and sent with that digest. igt's Baseline and
// ud's Text Editor save through it. Dependency-free but for errors.js, so the
// ud node suite reaches it by relative path.
//
// A lost answer is thrown to the write queue, which runs the save again with
// its plan as it is: the same request, under the same keys, answered from what
// it stored. Any other refusal of a send:
// - refused 409 as changed (`isTextChanged`) on a plan never sent before: the
//   server answers a key it stored before it looks at the digest, so nothing
//   under these keys is stored. The plan is made again on the text read now,
//   up to twice, and sent.
// - otherwise a send under these keys may have landed with its answer lost,
//   sent before or by the client inside its own resend, whatever the refusal
//   says (a 500, a 403, the key reused). The text is read: when it holds the
//   change the save is stored. A key reused for another request is a conflict.
//   A text changed is planned again, up to twice. Anything else is thrown.
//   A read that fails leaves the refusal as it is.

import { isKeyReused, isTextChanged, isUnknownOutcome } from './errors.js';

/**
 * @param {object} save
 * @param {() => Promise<boolean>} save.prepare - makes the plan when it is not
 *   made. False when there is nothing to send. What it throws (a conflict
 *   found while planning) is thrown as it is.
 * @param {() => Promise<any>} save.send - sends the plan. Resolves to the
 *   answer.
 * @param {() => boolean} save.sentBefore - whether the plan the last `send`
 *   went with was sent before under the same keys, so its answer, or a
 *   refusal of it, may be the first send's.
 * @param {() => Promise<object>} save.readStored - reads the text as stored,
 *   puts it on screen, and answers it.
 * @param {(stored: object) => boolean} save.holds - whether `stored` holds the
 *   plan's change.
 * @param {(stored: object|null) => Promise<void>} save.replan - makes the plan
 *   again on `stored`, or on the text read again when null.
 * @param {string} save.conflict - the message of a key reused for another
 *   request.
 * @returns {Promise<{answer: any} | {stored: object} | {nothing: true}>} the
 *   answer of the send that landed, the stored text that holds the change, or
 *   nothing to send.
 */
export async function sendTextPlan({
  prepare,
  send,
  sentBefore,
  readStored,
  holds,
  replan,
  conflict,
}) {
  for (let attempt = 0; ; attempt += 1) {
    if (!(await prepare())) return { nothing: true };
    try {
      return { answer: await send() };
    } catch (err) {
      if (isUnknownOutcome(err)) throw err;
      const changed = isTextChanged(err);
      if (changed && !sentBefore()) {
        if (attempt >= 2) throw err;
        await replan(null);
        continue;
      }
      let stored;
      try {
        stored = await readStored();
      } catch {
        throw err;
      }
      if (holds(stored)) return { stored };
      if (isKeyReused(err)) throw new Error(conflict, { cause: err });
      if (!changed || attempt >= 2) throw err;
      await replan(stored);
    }
  }
}
