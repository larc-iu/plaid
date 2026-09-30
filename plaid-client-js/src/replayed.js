// A write sent under an Idempotency-Key whose request the server had already
// run (its first answer was lost, and the client sent it again) is answered
// from what that first send stored, with `Idempotent-Replayed: true`, and
// writes nothing. The client resends on its own (retryUnknown), so the header
// never reaches the caller. It is marked on the answer instead: `replayed`,
// true and not enumerable, so the answer reads, compares and serializes as it
// would unmarked. Only an answer with a JSON object or list body can carry it.
// Imports nothing.

/** `value` marked as replayed, when it is an object or a list. */
export function markReplayed(value) {
  if (value !== null && typeof value === "object") {
    Object.defineProperty(value, "replayed", {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
  return value;
}

/** Whether a client answer was replayed from its key's first send. */
export const wasReplayed = (answer) =>
  answer !== null &&
  typeof answer === "object" &&
  Object.getOwnPropertyDescriptor(answer, "replayed")?.enumerable === false &&
  answer.replayed === true;
