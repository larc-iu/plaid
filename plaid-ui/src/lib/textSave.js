// A text save: its plan (makeTextPlan, planOn, sendingPlan) and the resend
// loop around its send (sendTextPlan): the edits typed, planned as gaps over a
// body whose digest the server issued, and sent with that digest. igt's Baseline and
// ud's Text Editor save through it. Dependency-free but for errors.js and textMerge.js, so the
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
import { rebaseEdits } from './textMerge.js';

/**
 * A text save's plan, kept outside its send so a run of the send after a lost
 * answer sends the same request under the same keys: the gaps typed over
 * `base` (code points, editLog.js), the digest the server issued for `base`
 * when known, and the key seed, null until `planOn` makes it ready.
 */
export const makeTextPlan = ({ base, digest = null, gaps }) => ({
  base,
  digest,
  gaps,
  keys: null,
  sentUnder: null,
});

/**
 * Make `plan` ready to send on the text as stored, `{ body, digest }`, or on
 * the text `read()` answers when `stored` is null: its gaps moved onto that
 * body when it has moved on (a change to the same passage throws
 * `conflict`), its digest, and new keys (`keySeed`). With no digest known the
 * text is read once more, and then the save is refused (`unread`): no plan
 * goes without one. False when the gaps change nothing.
 *
 * @param {object} plan - from makeTextPlan
 * @param {{body: string, digest: string|null}|null} stored
 * @param {object} how
 * @param {() => Promise<{body: string, digest: string|null}>} how.read - the
 *   text read again, as stored
 * @param {() => any} how.keySeed - a new key seed (the client's keySeed)
 * @param {string} how.conflict - the message of a change that cannot be moved
 * @param {string} how.unread - the message of a text read with no digest
 */
export async function planOn(plan, stored, { read, keySeed, conflict, unread }) {
  let now = stored ?? (await read());
  for (let reads = stored ? 0 : 1; ; reads += 1) {
    if (now.body !== plan.base) {
      const moved = rebaseEdits(plan.base, plan.gaps, now.body);
      if (moved.conflict) throw new Error(conflict);
      plan.base = now.body;
      plan.gaps = moved.gaps;
      plan.digest = now.digest ?? null;
    } else {
      plan.digest = now.digest ?? plan.digest;
    }
    if (plan.gaps.length === 0) return false;
    if (plan.digest != null) break;
    if (reads >= 1) throw new Error(unread);
    now = await read();
  }
  plan.keys = keySeed?.() ?? null;
  return true;
}

/**
 * Note that `plan` goes out now, and answer whether it went under these keys
 * before, so that its answer, or a refusal of it, may be the first send's.
 */
export function sendingPlan(plan) {
  const again = plan.keys != null && plan.sentUnder === plan.keys;
  plan.sentUnder = plan.keys;
  return again;
}

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
