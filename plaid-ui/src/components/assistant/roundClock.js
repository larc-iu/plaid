// How long the model call under way has been working, for the trace's
// "Thinking, 45 s".
//
// A turn is a run of model calls ("rounds"). Every progress event of a chat
// turn carries `round` (plaid_agent core/turn.py, set by the loop in
// core/agent.py): the call under way as `{n, began, waiting}`, `began` the
// service's clock in ISO, `waiting` while it waits for a busy model, or null
// while a tool runs. The page reads that and never the event's line, so a
// reload or a second tab joining mid-round counts from the true start.

import { t } from '../../lib/i18n.js';

// When the model call under way began (ms), while the model works on it with
// no text yet, else null. Null too where the service says nothing of the
// round (another assistant, an older service): no count is shown.
//
// `began` is the service's clock and the count runs on the browser's, which
// may disagree (REV-SVU-R2-1). So the start is held between the turn's start
// (`startedAt`) and when this page first heard of the round
// (`roundSeen.at`): a service clock ahead never freezes the count at 0 s, and
// one behind never counts longer than the turn.
export const roundSince = (job) => {
  const round = job?.round;
  if (job?.kind !== 'turn' || !round || round.waiting || job.partial || job.stopping) return null;
  const began = typeof round.began === 'string' ? Date.parse(round.began) : NaN;
  if (!Number.isFinite(began)) return null;
  const seen = job.roundSeen;
  const heard = seen?.n === round.n && seen?.began === round.began ? seen.at : null;
  const latest = Number.isFinite(heard) ? Math.min(began, heard) : began;
  return Number.isFinite(job.startedAt) ? Math.max(job.startedAt, latest) : latest;
};

// "Thinking, 45 s", or "Thinking, 2 min 5 s" from a minute on.
export const thinkingFor = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes
    ? t('Thinking, {minutes} min {seconds} s', { minutes, seconds })
    : t('Thinking, {seconds} s', { seconds });
};
