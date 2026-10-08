// Sending the user's last message again, and what a turn the reader stopped
// had already got through.

import { itemTime } from './itemTime.js';

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

// Whether item `i` is the stop record the retry line stands in for.
export const hidesStopped = (display, i) => i === display.length - 1 && !!display[i]?.stopped;

// What sending the user's last message again starts from. The attempt that
// failed stays in the conversation, so the record keeps every failure: the
// question and the line saying how it ended, with the retry asked again below
// them. Only the model transcript goes back to before that question, so the
// model reads it once. A turn that got no answer at all has no such line yet,
// and is given the one the screen showed under it (`stopped` when the reader
// stopped it). Returns null when there is nothing to retry.
export const rewindForRetry = (conv, { stopped = false } = {}) => {
  const i = (conv?.display || []).map((d) => d.kind).lastIndexOf('user');
  if (i < 0) return null;
  const text = conv.display[i].text || '';
  // The files the message carried. Their parts are already stored under this
  // conversation, so sending it again points at the same ones rather than
  // writing them twice or losing them.
  const files = conv.display[i].files || [];
  // The other projects it read. The service reads them off the last user
  // message only, so a message sent again without them reads its home
  // project alone, and says nothing about it.
  const projects = conv.display[i].projects || [];
  // A turn with no answer, lost, failed or stopped, still has the user's
  // message in the model transcript (stamped by the service when the turn
  // got that far), and it comes off so the retry sends it once. Only that
  // message: a note written after it (a plan approved or discarded since)
  // stays.
  // A turn whose answer was saved but whose save went unanswered has the
  // message AND the answer, the message stamped by the service: the
  // transcript goes back to before that message, or the retry sends it twice.
  const { messages } = conv;
  const answered = conv.display.slice(i + 1).some((d) => d.kind === 'assistant');
  const last = messages.findLastIndex((m) => isMessage(m, text));
  const at = answered || messages.slice(last + 1).every((m) => m?.role === 'user') ? last : -1;
  const rewound =
    at < 0
      ? messages
      : answered
        ? messages.slice(0, at)
        : [...messages.slice(0, at), ...messages.slice(at + 1)];
  const ended = i < conv.display.length - 1;
  const unanswered = stopped
    ? { kind: 'error', stopped: true, text: 'Stopped.', createdAt: itemTime() }
    : {
        kind: 'error',
        lost: true,
        text: 'No answer came back for this message.',
        createdAt: itemTime(),
      };
  return {
    text,
    files,
    projects,
    conv: {
      ...conv,
      messages: rewound,
      display: ended ? conv.display : [...conv.display, unanswered],
    },
  };
};

// The model's copy of a user message: the text as sent, or with the notes the
// service stamps in front of it (the place, the projects, the files), each
// ending in a blank line.
const isMessage = (m, text) =>
  m?.role === 'user' &&
  typeof m.content === 'string' &&
  (m.content === text || m.content.endsWith(`\n\n${text}`));
