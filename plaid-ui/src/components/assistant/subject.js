import { createContext, useContext, useEffect, useRef } from 'react';

// What the reader is looking at, published by the screen showing it and read by
// the assistant panel in the app shell.
//
// The panel used to be mounted by the screen it belonged to, which is why there
// were three of them: one beside a document, one beside a vocabulary, and the
// full tab. Each carried its own layout, and each had to be handed the same
// half-dozen facts about the project. Now the shell mounts one panel and the
// screen publishes what it is showing, so a screen that wants the assistant to
// know where the reader is adds one hook call and no layout at all.
//
// A screen publishes:
//   projectId, projectName   whose assistant, and what to call the project.
//                            Required: the assistant is per project (discovery,
//                            the conversation records and the agent's workspace
//                            are all addressed by one), so a screen with no
//                            project publishes nothing and the panel holds
//                            whatever thread it already has.
//   kind, id, name           the one thing in front of the reader, or kind:null
//                            for a screen that is about the project at large.
//                            Only kinds the assistant has TOOLS for are worth
//                            naming: telling the model the reader is on the
//                            export screen invites it to claim it can export.
//   canWrite, contributor    what this reader may do here, which decides
//                            whether a plan can be applied and how its writes
//                            are attributed.
//   onApplied                an approved plan wrote to this screen's data.
//                            Refresh IN PLACE: a rebuild costs the reader
//                            their scroll position and focus for a change they
//                            just approved and want to look at.
//   onFocusHere              a citation points at something on this screen.
//                            Return true to claim it (and scroll there), false
//                            to let the link open the place itself.
//
// The callbacks are held in a ref and deliberately NOT part of what re-publishes
// the subject: a screen that passes them inline (which every screen does) would
// otherwise publish a new subject on every render, and the panel would reset on
// each one.

export const SubjectContext = createContext(null);

// The panel's side: what is currently published, or null.
export const useAssistantScope = () => useContext(SubjectContext)?.subject ?? null;

// A screen's side. Publishes while mounted, clears on unmount.
export const useAssistantSubject = ({
  projectId,
  projectName,
  kind = null,
  id = null,
  name = null,
  canWrite = false,
  contributor = false,
  onApplied,
  onFocusHere,
} = {}) => {
  const ctx = useContext(SubjectContext);
  const setSubject = ctx?.setSubject;
  // The screen's latest handlers, reachable without re-publishing. The panel
  // calls through these wrappers, so it always reaches the current ones even
  // though the subject it holds was published when the screen mounted.
  const handlers = useRef({ onApplied, onFocusHere });
  handlers.current = { onApplied, onFocusHere };

  useEffect(() => {
    if (!setSubject || !projectId) return undefined;
    const mine = {
      projectId,
      projectName,
      kind,
      id,
      name,
      canWrite,
      contributor,
      onApplied: () => handlers.current.onApplied?.(),
      onFocusHere: (arg) => handlers.current.onFocusHere?.(arg) ?? false,
    };
    setSubject(mine);
    return () => {
      // Only clear what is still OURS. A cleanup that ran after someone else
      // had published would otherwise leave the panel with no subject on a
      // screen that has one, and the orders this can happen in (a re-publish
      // when a dep changes, a development remount) are not worth relying on
      // one way or the other.
      setSubject((cur) => (cur === mine ? null : cur));
    };
  }, [setSubject, projectId, projectName, kind, id, name, canWrite, contributor]);
};
