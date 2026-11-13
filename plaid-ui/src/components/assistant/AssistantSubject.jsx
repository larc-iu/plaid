import { useCallback, useEffect, useMemo, useState } from 'react';
import { SubjectContext } from './subject.js';

// The shell wraps the app in this once: `useAssistantSubject` writes to it and
// `useAssistantScope` reads it, and `useAskAssistant` / `useAssistantFocus`
// carry the other direction (both in subject.js, with the contract).
export const AssistantSubjectProvider = ({ children }) => {
  const [subject, setSubject] = useState(null);
  // What a screen pointed at, as {ref, label}. It lives here rather than in
  // either shell because both ends of it are here: a screen anywhere under the
  // provider can point, and the one panel in the shell picks it up.
  const [focus, setFocus] = useState(null);
  const ask = useCallback((detail) => setFocus(detail || null), []);
  const clearFocus = useCallback(() => setFocus(null), []);
  // A new conversation a screen asked for, as a number new for each press, so
  // pressing again after the panel took the first is a request of its own.
  const [fresh, setFresh] = useState(null);
  const startConversation = useCallback(() => setFresh((n) => (n || 0) + 1), []);
  const clearFresh = useCallback(() => setFresh(null), []);

  // A reference into a document the reader has since left means nothing, so it
  // does not travel with them.
  const subjectId = subject?.id;
  useEffect(() => {
    setFocus(null);
  }, [subjectId]);

  const value = useMemo(
    () => ({ subject, setSubject, focus, ask, clearFocus, fresh, startConversation, clearFresh }),
    [subject, focus, ask, clearFocus, fresh, startConversation, clearFresh],
  );
  return <SubjectContext.Provider value={value}>{children}</SubjectContext.Provider>;
};
