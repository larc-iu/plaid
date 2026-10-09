// What the screen says of a turn that has no answer: the line beside Retry,
// and what a turn the reader stopped had already got through. Sending the
// message again is the service's (`rewind_for_retry` in plaid-agent).

// What a turn the reader STOPPED had already got through, if it was this
// conversation's. The live step list lives inside the panel's `busy` block and
// goes with it, so stopping would otherwise clear the screen of everything the
// turn had done, which is the one thing a reader wants at that moment.
//
// Held with its conversation, the way every other per-conversation fact in the
// panel is: the panel keeps one thread per project, but the reader can switch
// threads from its header, and an unscoped list put a stopped turn's steps
// under whatever conversation was on screen next.
export const stoppedIn = (stopped, convId) =>
  stopped && convId && stopped.convId === convId ? stopped : null;

// The line beside Retry under a turn that has no answer. A stop is recorded
// as an `error` item marked `stopped` ("Stopped."), which this line stands in
// for, so it is asked before the error and the item is not drawn as well
// (`hidesStopped`).
export const retryNote = (display, stoppedHere) => {
  const last = display.at(-1);
  if (last?.stopped || stoppedHere) return 'You stopped this turn.';
  return last?.kind === 'error'
    ? 'That turn did not finish.'
    : 'No answer came back for this message.';
};

// Whether the user's last message has an answer after it. Such a turn is
// never sent again: Retry would rewind the model transcript past an answer the
// reader can see.
export const answeredLast = (display) => {
  const items = display || [];
  const i = items.map((d) => d.kind).lastIndexOf('user');
  return i >= 0 && items.slice(i + 1).some((d) => d.kind === 'assistant');
};

// Whether item `i` is the stop record the retry line stands in for.
export const hidesStopped = (display, i) => i === display.length - 1 && !!display[i]?.stopped;
