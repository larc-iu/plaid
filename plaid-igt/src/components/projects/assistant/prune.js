// Keeping a conversation inside the size of one stored value.
//
// A conversation lives in the user's key/value store as a single entry, and
// the server caps one value's JSON at a megabyte (plaid-core's
// sql/user_data.clj). A turn may make dozens of tool calls whose results run
// to twelve thousand characters each, so a working session reaches that cap
// on its own, and once it does nothing more can be saved: the reply the user
// is looking at would be gone on reload.
//
// Tool results are almost all of that weight, and they are the part a
// conversation can spare: the reply that drew conclusions from them stays,
// and so does every question and every plan. So when a conversation grows
// past its budget the oldest tool results are dropped, in order, until it
// fits. The same transcript is what the next turn sends the model, so this
// also keeps a long conversation inside the model's context window.

export const CONVERSATION_BUDGET = 700000; // bytes, against the server's 1,000,000
export const DROPPED = '[This result was dropped to keep the conversation within its size limit.]';

const bytes = (value) => new TextEncoder().encode(JSON.stringify(value) ?? '').length;

// What the conversation weighs, measured on the value persistConv puts. The
// client recases keys on the way out (`toolCallId` goes as `tool-call-id`),
// so the stored text is a little longer than this, by a few bytes per key on
// a value that is almost entirely tool output. The gap between the budget and
// the server's cap covers that many times over.
export const conversationBytes = (conv) =>
  bytes({ messages: conv?.messages || [], display: conv?.display || [] });

export const pruneConversation = (conv, budget = CONVERSATION_BUDGET) => {
  let excess = conversationBytes(conv) - budget;
  if (excess <= 0) return conv;
  const dropped = bytes(DROPPED);
  const messages = conv.messages.map((m) => {
    if (excess <= 0 || m.role !== 'tool' || m.content === DROPPED) return m;
    excess -= bytes(m.content) - dropped;
    return { ...m, content: DROPPED };
  });
  return { ...conv, messages };
};
