import { useEffect, useRef } from 'react';
import { jobFor, lastOpen } from './jobs.js';

// Which conversation a surface comes up showing, decided once per project.
//
// ONE thread per project, wherever the reader is inside it. Each subject used
// to remember its own, which was right while the panel belonged to the screen
// that opened it: it appeared beside one document and resuming a thread about
// another would have answered about the wrong thing. The panel is app chrome
// now, so that rule would swap the conversation under the reader every time
// they walked to the next document, and nothing spanning two screens could be
// asked at all. Which place each question came from is recorded on the question
// instead (`where`, and the stamp the service writes).
//
// Once per project, and not once per load: `reload` is a dependency here, so
// widening the list to every project re-runs this, and only its READ should.
// Picking again would choose the newest thread anywhere, which neither surface
// can open.
export const useResumeConversation = ({
  projectId,
  // What is open now, and how to open another.
  conversationId,
  onConversationId,
  // Read the list, and answer with it.
  reload,
  // Come back to the project's most recent thread rather than opening new. The
  // docked panel does: it is chrome, it comes back on every screen and on every
  // visit, and a blank conversation each time would mean going to find what you
  // were in the middle of. The tab opens new, the way a chat app does, because
  // its sidebar puts every thread one click away.
  resumeNewest = false,
  // Nothing of this project's to show, and nothing named in the URL.
  onNothingOpen,
  // The id to come back to within this page session, asked for as the surface
  // is left. Null while nothing has been sent.
  openConversationId,
}) => {
  const resumed = useRef(null);
  const idRef = useRef(conversationId);
  idRef.current = conversationId;
  const setRef = useRef(onConversationId);
  setRef.current = onConversationId;
  const nothingRef = useRef(onNothingOpen);
  nothingRef.current = onNothingOpen;
  const openIdRef = useRef(openConversationId);
  openIdRef.current = openConversationId;

  useEffect(() => {
    const remembered = lastOpen.get(projectId);
    reload().then((metas) => {
      if (resumed.current === projectId) return;
      resumed.current = projectId;
      // Only a conversation of THIS project, whose keys are the only ones this
      // screen reads, and only one that still exists (it may have been deleted
      // meanwhile).
      const mine = metas.filter((m) => !m.projectId || m.projectId === projectId);
      const here = new Set(mine.map((m) => m.id));
      // A conversation named in the URL is respected, but only if it is this
      // project's. Walking from one project to another used to leave the one
      // we came from on screen with a live composer, and sending into it ran
      // the turn against THIS project while carrying the other one's
      // transcript, then saved a second, divergent copy under this project's
      // key: one conversation id, two projects, two different histories. A run
      // still going where we came from stays reachable through the "running
      // elsewhere" link, which is what switching away is supposed to leave you.
      if (idRef.current && here.has(idRef.current)) return;
      if (remembered && (jobFor(remembered) || here.has(remembered))) {
        setRef.current(remembered, { replace: true });
        return;
      }
      if (resumeNewest && mine.length) {
        setRef.current(mine[0].id, { replace: true });
        return;
      }
      // Nothing of this project's to show. Clear whatever the last one left,
      // rather than keeping it live over a project it does not belong to.
      if (idRef.current) setRef.current(null, { replace: true });
      else nothingRef.current?.();
    });
    return () => {
      const id = openIdRef.current?.();
      if (id) lastOpen.set(projectId, id);
      else lastOpen.delete(projectId);
    };
  }, [reload, projectId, resumeNewest]);
};
