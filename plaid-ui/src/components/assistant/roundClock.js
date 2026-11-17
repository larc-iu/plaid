// How long the model call under way has been working, as the page counts it.
//
// A turn is a run of model calls ("rounds"). The service says a round has
// begun by sending one of these lines as the turn's progress message
// (plaid_agent/core/agent.py, at the top of its loop), and says something
// else once the round has an outcome: a tool's own line while the tool runs,
// "Writing…" once the reply's text streams, or the line of a wait for a busy
// model. A round's steps land in the trace after its tools ran, so the next
// round's line arrives with a longer trace.
export const ROUND_LINES = new Set(['Thinking…', 'Thinking more…']);

// The round after a progress event, as `{steps, at, shown}`: `at` is when the
// page first saw this round (keyed by how many steps the trace held), so a
// wait for a busy model in the middle of it does not start the count again,
// and `shown` says whether the model is working on it now.
export const roundAfter = (round, message, steps, now) => {
  if (!ROUND_LINES.has(message)) return round ? { ...round, shown: false } : null;
  return { steps, at: round?.steps === steps ? round.at : now, shown: true };
};

// "Thinking, 45 s", or "Thinking, 2 min 5 s" from a minute on.
export const thinkingFor = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `Thinking, ${minutes} min ${seconds} s` : `Thinking, ${seconds} s`;
};
