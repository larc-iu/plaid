import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/button.jsx';
import { assistantGate } from './assistantGate.js';
import { AssistantDock } from './AssistantDock.jsx';
import { AssistantRail } from './AssistantRail.jsx';
import { AssistantMark } from './PlaidMarks.jsx';
import { ProjectPicker } from './ProjectPicker.jsx';
import { readDockOpen, saveDockOpen } from './panelWidth.js';
import { useAssistantFocus } from './subject.js';
import { useAssistantAvailable } from './useAssistantAvailable.js';
import { useDockWidth } from './useDock.js';

// The assistant as part of an app's chrome: the header chip, the edge rail,
// the docked panel, and the gutter the page leaves for it.
//
// Both shells held a copy of this, ninety lines apiece differing in prose. It
// lives here instead, and an app hands it the four things it alone knows: its
// adapter, its client, its user, and the subject its current screen published.
// Everything else about the panel is the same in every app, including the
// decision that it survives a navigation, which is the whole point of it being
// chrome.
//
// The page's own markup comes back as a RENDER PROP, because the chip belongs
// in the app's header, among the app's own controls, and only the app knows
// where that is. The padded wrapper is here so the gutter and the dock cannot
// disagree about whether there is a panel.
//
// The panel's project comes from whatever screen published a subject, and the
// LAST one seen is kept when the reader walks onto a screen that has none (a
// vocabulary list, /admin, /profile). The assistant is per project all the way
// down (discovery, the conversation records, the agent's workspace), so
// "always available" can only mean the panel keeps the thread it has rather
// than becoming a project-less chat, which would be a chat with 2 of its 64
// tools.
export const AssistantChrome = ({
  adapter,
  client,
  user,
  // What the screen on show published, or null. Passed WHOLE: splitting it
  // into a document id, a document name, a lexicon id and a lexicon name meant
  // the shell knew one app's kinds and the panel put them back together again.
  // Its callbacks (onApplied, onFocusHere, mentions) ride along on it.
  subject = null,
  // Whether the route is itself under a project, which is what keeps the
  // project picker off the new-project wizard and the importers.
  routeHasProject = false,
  // Whether the screen on show IS the app's Assistant tab. Each app spells its
  // own: IGT's is a `?tab=`, UD's a route segment.
  assistantRoute = false,
  className,
  children,
}) => {
  // --- the dock -------------------------------------------------------------
  // Where the reader left it, within the session and across a load: a thread
  // they were in the middle of is the likeliest reason they came back. A reader
  // who has never opened it gets it shut (see panelWidth.js).
  const [open, setOpen] = useState(readDockOpen);
  const { width, resize, wide } = useDockWidth();
  const setDockOpen = useCallback((next) => {
    setOpen(next);
    saveDockOpen(next);
  }, []);

  // The project the panel is about. A screen with no project of its own leaves
  // the thread where it was rather than closing it, and one chosen in the
  // picker below is held the same way. A picked project carries no permissions
  // with it, so plans cannot be applied until the reader opens the project
  // itself, which is where those facts are read: it is a floor, not a fence,
  // and the server is the one that decides either way.
  //
  // What the reader may DO travels with the project, not with the screen. Both
  // are facts about the project, and reading them off the current subject meant
  // a thread could apply a plan while its own project screen was open and not
  // while the reader was on the vocabulary list, which is the same thread and
  // the same permission.
  const [held, setHeld] = useState(null);
  useEffect(() => {
    if (!subject?.projectId) return;
    setHeld({
      projectId: subject.projectId,
      projectName: subject.projectName,
      canWrite: subject.canWrite,
      contributor: subject.contributor,
    });
  }, [subject?.projectId, subject?.projectName, subject?.canWrite, subject?.contributor]);
  const project = subject?.projectId ? subject : held;
  const projectId = project?.projectId || null;
  const available = useAssistantAvailable(client, projectId, adapter.app);
  const gate = assistantGate({
    wide,
    open,
    projectId,
    available,
    routeHasProject,
    assistantRoute,
  });

  // What the reader pointed at, as {ref, label}: "Ask", beside a sentence or an
  // entry. Pointing at something opens the panel, because it is how you start
  // asking.
  const { focus, clearFocus } = useAssistantFocus();
  useEffect(() => {
    if (focus) setDockOpen(true);
  }, [focus, setDockOpen]);

  // Published for anything painted outside this tree that must not sit under
  // the dock. The toaster is mounted at the root, above the router, so it
  // cannot read this from React (see plaid-ui's index.css).
  const dockWidth = gate.showDock ? width : 0;
  useEffect(() => {
    document.documentElement.style.setProperty('--plaid-dock-width', `${dockWidth}px`);
    return () => document.documentElement.style.removeProperty('--plaid-dock-width');
  }, [dockWidth]);

  // Named, in the place app-level controls live, and offered on every screen:
  // the rail at the right edge is the same gesture in the place the panel comes
  // from, but it is a sliver that says nothing until it is hovered, and the
  // assistant should not have to be hunted for.
  const chip = gate.showHandle ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => setDockOpen(true)}
      title="Assistant"
    >
      <AssistantMark className="h-4 w-4" />
      Assistant
    </Button>
  ) : null;

  return (
    <div className={className} style={{ paddingRight: gate.showDock ? width : undefined }}>
      {children({ chip })}
      {gate.showHandle && <AssistantRail onOpen={() => setDockOpen(true)} />}
      {gate.showDock && (
        <AssistantDock
          width={width}
          onResize={resize}
          onClose={() => setDockOpen(false)}
          projectId={projectId}
          projectName={project?.projectName || null}
          client={client}
          userId={user?.id}
          canWrite={!!project?.canWrite}
          contributor={!!project?.contributor}
          adapter={adapter}
          subject={subject}
          focus={focus}
          onClearFocus={clearFocus}
          picker={
            gate.showPicker ? (
              <ProjectPicker
                client={client}
                onPick={(p) => setHeld({ projectId: p.id, projectName: p.name })}
                onHide={() => setDockOpen(false)}
              />
            ) : null
          }
        />
      )}
    </div>
  );
};
