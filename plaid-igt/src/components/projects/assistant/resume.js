// Recognising work that was interrupted, and rewinding a conversation so the
// user's last message can be sent again.
//
// A conversation was interrupted when what is stored says work was under way
// but no job is in flight for it (see ProjectAssistant's job registries): the
// page was reloaded or closed before the answer or the write came back. Both
// shapes are unambiguous. `send` appends the user's item and every outcome
// appends an assistant or error item after it, and a plan reads 'applying'
// only between the request and its result.

export const unansweredTurn = (conv) => conv?.display.at(-1)?.kind === 'user';

export const applyingIndex = (conv) =>
  conv?.display.findIndex((d) => d.status === 'applying') ?? -1;

// Rewind to just before the user's last message, so sending it again rebuilds
// the same request. Returns null when there is nothing to retry.
export const rewindForRetry = (conv) => {
  const i = (conv?.display || []).map((d) => d.kind).lastIndexOf('user');
  if (i < 0) return null;
  const text = conv.display[i].text || '';
  // An interrupted turn still has the user's message in the model transcript;
  // a failed one had it dropped so a retry could not send it twice.
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
