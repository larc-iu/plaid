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

  // A reference into a document the reader has since left means nothing, so it
  // does not travel with them.
  const subjectId = subject?.id;
  useEffect(() => {
    setFocus(null);
  }, [subjectId]);

  const value = useMemo(
    () => ({ subject, setSubject, focus, ask, clearFocus }),
    [subject, focus, ask, clearFocus],
  );
  return <SubjectContext.Provider value={value}>{children}</SubjectContext.Provider>;
};
