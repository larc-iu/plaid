// Reading many documents for one run: igt's Bulk Edit previews and Export,
// ud's and umr's exports, umr's Validation scan.
//
// Each needs every affected document in full, and on a large project that is
// thousands of reads. One at a time, the run is almost all waiting: 1,413
// reads took 52 seconds for one respell preview. Four at a time, the server's
// readers work side by side, which is the bound the assistants' corpus reader
// uses too (plaid-agent `core/docload.py`, WORKERS = 4) and well under the
// server's ten pooled connections, so a run never takes every connection from
// the people editing.

/** Reads in flight at once, for a run over many documents. */
export const READS_IN_FLIGHT = 4;

/**
 * Run `read(id)` for every id, at most `inFlight` at a time, and yield each
 * outcome in the order of `ids`: `{ id, value }`, or `{ id, error }` when the
 * read failed. A read is started only while fewer than `inFlight` outcomes
 * are waiting for the caller, so however slowly the caller takes them, no
 * more than that many documents are held. Leaving the loop early starts no
 * further reads; the ones already sent finish and are dropped.
 */
export async function* readInOrder(ids, read, { inFlight = READS_IN_FLIGHT } = {}) {
  const pending = new Array(ids.length);
  let started = 0;
  let taken = 0;
  let stopped = false;
  const fill = () => {
    while (!stopped && started < ids.length && started - taken < inFlight) {
      const id = ids[started];
      pending[started] = Promise.resolve()
        .then(() => read(id))
        .then(
          (value) => ({ id, value }),
          (error) => ({ id, error }),
        );
      started += 1;
    }
  };
  try {
    while (taken < ids.length) {
      fill();
      const outcome = await pending[taken];
      pending[taken] = undefined;
      taken += 1;
      // The next read goes out before the caller works on this one.
      fill();
      yield outcome;
    }
  } finally {
    stopped = true;
  }
}

/**
 * Every read's value, in the order of `ids`, `inFlight` at a time. The first
 * failure fails the whole run and sends nothing further.
 * `onProgress(done, total)` follows the reads as they are taken.
 */
export async function readAll(ids, read, { onProgress, inFlight } = {}) {
  const out = [];
  for await (const { value, error } of readInOrder(ids, read, { inFlight })) {
    if (error) throw error;
    out.push(value);
    onProgress?.(out.length, ids.length);
  }
  return out;
}
