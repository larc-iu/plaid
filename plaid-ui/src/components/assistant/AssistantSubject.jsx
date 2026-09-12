import { useMemo, useState } from 'react';
import { SubjectContext } from './subject.js';

// The shell wraps the app in this once: `useAssistantSubject` writes to it and
// `useAssistantScope` reads it (both in subject.js, with the contract).
export const AssistantSubjectProvider = ({ children }) => {
  const [subject, setSubject] = useState(null);
  const value = useMemo(() => ({ subject, setSubject }), [subject]);
  return <SubjectContext.Provider value={value}>{children}</SubjectContext.Provider>;
};
