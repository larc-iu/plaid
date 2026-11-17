// How long the model call under way has been working, for the trace's
// "Thinking, 45 s".
//
// A turn is a run of model calls ("rounds"). Every progress event of a chat
// turn carries `round` (plaid_agent core/turn.py, set by the loop in
// core/agent.py): the call under way as `{n, began, waiting}`, `began` the
// service's clock in ISO, `waiting` while it waits for a busy model, or null
// while a tool runs. The page reads that and never the event's line, so a
// reload or a second tab joining mid-round counts from the true start.

// When the model call under way began (ms), while the model works on it with
// no text yet, else null. Null too where the service says nothing of the
// round (another assistant, an older service): no count is shown.
export const roundSince = (job) => {
  const round = job?.round;
  if (job?.kind !== 'turn' || !round || round.waiting || job.partial || job.stopping) return null;
  const at = typeof round.began === 'string' ? Date.parse(round.began) : NaN;
  return Number.isFinite(at) ? at : null;
};

// "Thinking, 45 s", or "Thinking, 2 min 5 s" from a minute on.
export const thinkingFor = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `Thinking, ${minutes} min ${seconds} s` : `Thinking, ${seconds} s`;
};
