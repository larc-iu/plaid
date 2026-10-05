// Whether a reply this panel was waiting on has just landed, for the one
// line a screen reader hears ("Reply ready"). `before` and `now` are
// `{ busy, id, display }`: the job under way, the conversation, its items.
// Opening another conversation, or one that grew while nothing here was
// waiting, says nothing, and neither does a turn that ended in an error.
export function replyLanded(before, now) {
  if (!before || before.busy !== 'turn' || now.busy) return false;
  if (before.id !== now.id || now.display.length <= before.length) return false;
  const last = now.display[now.display.length - 1];
  return !!last && last.kind !== 'user' && last.kind !== 'error';
}
