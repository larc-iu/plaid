import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

// Which conversation the Assistant tab is showing, kept in the URL
// (`?conversation=<id>`), so a thread can be shared, opened in a new tab, and
// backed out of. No conversation in the URL is a new one.
//
// The docked panel keeps its own in state instead: it lives on whatever route
// the reader is on, and that URL is the document's, not the assistant's.
export const useConversationParam = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const set = useCallback(
    (id, options) =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('conversation', id);
        else next.delete('conversation');
        return next;
      }, options),
    [setSearchParams],
  );
  return [searchParams.get('conversation'), set];
};
