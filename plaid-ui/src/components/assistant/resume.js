// Recognising a turn that never got its answer, and rewinding a conversation
// so the user's last message can be sent again.
//
// The service writes every outcome into the conversation record (a reply, a
// stop, an error), so a conversation whose last item is still the user's
// message, with no request under way for it, is one whose request was lost:
// the server or the service went away before the record was written.

export const unansweredTurn = (conv) => conv?.display.at(-1)?.kind === 'user';

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

// Rewind to just before the user's last message, so sending it again rebuilds
// the same request. Returns null when there is nothing to retry.
export const rewindForRetry = (conv) => {
  const i = (conv?.display || []).map((d) => d.kind).lastIndexOf('user');
  if (i < 0) return null;
  const text = conv.display[i].text || '';
  // A lost turn still has the user's message in the model transcript; a
  // failed or stopped one had it dropped so a retry could not send it twice.
  const last = conv.messages.at(-1);
  return {
    text,
    conv: {
      ...conv,
      messages:
        last?.role === 'user' && last.content === text ? conv.messages.slice(0, -1) : conv.messages,
      display: conv.display.slice(0, i),
    },
  };
};
