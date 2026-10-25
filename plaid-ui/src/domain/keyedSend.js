// A write queued on a WriteQueue under a logical operation of its own and an
// Idempotency-Key seed (the client's `keySeed`), both fixed when the write is
// queued. A send whose answer was lost goes again under the same keys until it
// is answered (WriteQueue `resendWhenBack`), and what landed the first time
// is answered from what it stored. The vocabulary screens in plaid-igt send
// this way. DocumentModel has its own queue write with more in it.
//
// A write planned from a read plans once. `plan()` runs in the write's turn,
// before the first send, and every send after it hands `write` what that plan
// resolved to: a resend that read again would see its own first writes and
// plan other requests under the same keys (a Replace that finds nothing left
// to replace, an import that finds its own entries). A plan whose read the
// network failed is tried again in the same way, since nothing was sent.
//
// A first send that never reached the server leaves the plan as old as the
// outage, and another person may have changed what it read meanwhile.
// `recheck(planned)`, when given, runs before every resend: it reads again,
// keeps what its own first send landed, and drops or refuses what someone
// else moved. What it resolves to is what that send and the ones after it
// send.
//
// Imports only errors.js and the client's ids.js, which import nothing, the
// way WriteQueue does.

import { isUnknownOutcome, isUnreachable } from '../lib/errors.js';
import { uuidv7 } from '../../../plaid-client-js/src/ids.js';

/**
 * Queue `write(setMessage, planned)` on `queue` under the operation `label`.
 *
 * `plan()`, when given, runs once, and what it resolves to is `planned` for
 * every send. `recheck(planned)`, when given, runs before each resend and
 * resolves to what that resend sends, or throws to refuse it. `minted` is the ids the write mints for what it creates, so a
 * create refused `id-taken` for one of them answers as made. `kind` and `ref`
 * tag the operation (the client's beginOperation). `refused`, `resync` and
 * `shown` are the queue's (WriteQueue `push`). Resolves to whether it landed.
 */
export const keyedSend = (
  queue,
  client,
  label,
  write,
  {
    plan = null,
    recheck = null,
    minted,
    kind,
    ref,
    refused = null,
    resync = null,
    shown = true,
  } = {},
) => {
  const operation = {
    ...(minted ? { minted } : {}),
    ...(kind ? { kind } : {}),
    ...(ref ? { ref } : {}),
    groupId: uuidv7(),
    keys: client.keySeed?.(),
  };
  let planned;
  let isPlanned = !plan;
  let sent = false;
  let checking = false;
  return queue.push(
    async () => {
      if (!isPlanned) {
        planned = await plan();
        isPlanned = true;
      } else if (sent && recheck) {
        checking = true;
        planned = await recheck(planned);
        checking = false;
      }
      sent = true;
      return client.withOperation(label, (setMessage) => write(setMessage, planned), operation);
    },
    {
      refused,
      resync,
      shown,
      resendWhenBack: (err) =>
        isUnknownOutcome(err) || ((!isPlanned || checking) && isUnreachable(err)),
    },
  );
};
