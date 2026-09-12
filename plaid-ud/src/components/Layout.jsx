import { useCallback, useEffect, useState } from 'react';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { AssistantMark, PlaidMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { UserButton } from '@ui/components/shared/UserButton';
import { Button } from '@ui/components/ui/button';
import { headerItem } from '@ui/components/shared/headerItem.js';
import { AssistantDock } from '@ui/components/assistant/AssistantDock.jsx';
import { ProjectPicker } from '@ui/components/assistant/ProjectPicker.jsx';
import { AssistantSubjectProvider } from '@ui/components/assistant/AssistantSubject.jsx';
import { useAssistantFocus, useAssistantScope } from '@ui/components/assistant/subject.js';
import { useDockWidth } from '@ui/components/assistant/useDock.js';
import { readDockOpen, saveDockOpen } from '@ui/components/assistant/panelWidth.js';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { UD_ASSISTANT } from './assistant/adapter.js';
import { adminUrl } from '../domain/siblingApps.js';

// The shell, and the one place the assistant panel is mounted.
//
// It is already a LAYOUT route (App.jsx), so it mounts once and the screens
// swap inside its `Outlet`. That is what lets a panel living here hold a
// conversation from one screen to the next, which is the whole point of moving
// it off the annotation editor: an answer can be read while the reader gets on
// with something else, and a question can span two documents.
//
// The panel's project comes from whatever screen published a subject
// (ProjectTabs for the project's own screens, DocumentEditorShell for a
// document), and the LAST one seen is kept when the reader walks onto a screen
// that has none (/projects, /profile). The assistant is per project all the way
// down (discovery, the conversation records, the agent's workspace), so
// "always available" can only mean the panel keeps the thread it has rather
// than becoming a project-less chat.
const Shell = () => {
  const { user, logout, getClient } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // `getClient` throws when nobody is signed in, and this is a layout route:
  // everything below it is guarded, but the shell itself renders first.
  const client = user ? getClient() : null;
  const subject = useAssistantScope();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // --- the dock -------------------------------------------------------------
  const [open, setOpen] = useState(readDockOpen);
  const { width, resize, shown, wide } = useDockWidth(open);
  const setDockOpen = useCallback((next) => {
    setOpen(next);
    saveDockOpen(next);
  }, []);

  // Published for anything painted outside this tree that must not sit under
  // the dock. The toaster is mounted at the root, above the router, so it
  // cannot read this from React (see index.css).
  useEffect(() => {
    const px = shown ? `${width}px` : '0px';
    document.documentElement.style.setProperty('--plaid-dock-width', px);
    return () => document.documentElement.style.removeProperty('--plaid-dock-width');
  }, [shown, width]);

  // The project the panel is about. A screen with no project of its own leaves
  // the thread where it was rather than closing it, and one chosen in the
  // picker below is held the same way. A picked project carries no permissions
  // with it, so plans cannot be applied until the reader opens the project
  // itself, which is where those facts are read: it is a floor, not a fence,
  // and the server is the one that decides either way.
  //
  // What the reader may DO travels with the project, not with the screen: both
  // are facts about the project, so a thread that can apply a plan on the
  // document screen can still apply one from the project list.
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
  const projectName = project?.projectName || null;
  const available = useAssistantAvailable(client, projectId, UD_ASSISTANT.app);
  // Whether to offer the picker: only where no project is in scope AND the
  // route is not itself under a project. The route test keeps a chat about some
  // other project off a project screen that is still loading its own.
  const routeHasProject = /^\/projects\/[^/]+/.test(location.pathname);
  const offerPicker = !projectId && !routeHasProject;

  // What the reader pointed at, as {ref, label}: "Ask" under a sentence, which
  // reaches here through the subject context (see DocumentEditorShell).
  const { focus, clearFocus } = useAssistantFocus();
  // Pointing at something opens the panel: it is how you start asking.
  useEffect(() => {
    if (focus) setDockOpen(true);
  }, [focus, setDockOpen]);

  // The annotation editor wants the full viewport width; every other screen is
  // constrained to a centered container.
  const isAnnotationEditor = location.pathname.includes('/annotate');

  return (
    <div
      className="flex min-h-screen flex-col bg-background text-foreground"
      style={{ paddingRight: shown ? width : undefined }}
    >
      <header className="border-b bg-background">
        {/* `h-14`, the same band as plaid-igt's, which is also what the
            assistant panel's own header measures itself against. The width is
            this app's own: the band has to line up with the container below
            it, and plaid-ud's screens are wider. */}
        <div className="mx-auto flex h-14 max-w-[1320px] items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-bold">
            <PlaidMark className="h-[18px] w-[18px] shrink-0" />
            Plaid UD
          </Link>
          {user && (
            <div className="flex items-center gap-2">
              {/* Offered wherever there is a project for it to be about, which
                  includes the one the panel is holding, and only when an
                  assistant is actually online there: a control that opens an
                  empty panel is worse than no control. `available` is null
                  until that is known, which is also not offered, and it answers
                  from a per-project cache so a navigation does not flicker it
                  away and back. Not offered in a window too narrow to give it
                  width. */}
              {wide && !shown && (projectId ? available : offerPicker) && (
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
              )}
              {/* The server's admin area is plaid-igt's. The release jar always
                  ships both apps on one server, so there is exactly one, and a
                  second here would be a second answer to the same question.
                  A real anchor, not a Link: it is another document. */}
              {user.isAdmin && (
                <a href={adminUrl()} className={headerItem()}>
                  Admin
                </a>
              )}
              {/* Profile and Logout are both in here now. Two bare text
                  buttons beside the name made the account three controls wide
                  and left Logout one stray click from Profile. */}
              <UserButton user={user} client={client} onLogout={handleLogout} />
            </div>
          )}
        </div>
      </header>

      <main className="flex-1">
        {/* One container that changes shape, never a `cond ? <Outlet/> :
            <div><Outlet/></div>`. Swapping the element AT this position would
            unmount everything below it when you move into or out of /annotate: 
            which is exactly the remount DocumentEditorShell exists to prevent,
            since the shell renders through this Outlet. */}
        {/* Preflight is global now, so nothing here scopes it. Every screen
            and each migrated one brings its own. */}
        <div className={isAnnotationEditor ? 'w-full' : 'mx-auto max-w-[1320px] px-4 py-8'}>
          <Outlet />
        </div>
      </main>

      {shown && (projectId ? available !== false : offerPicker) && (
        <AssistantDock
          open
          width={width}
          onResize={resize}
          onClose={() => setDockOpen(false)}
          projectId={projectId}
          projectName={projectName}
          client={client}
          userId={user?.id}
          canWrite={!!project?.canWrite}
          contributor={!!project?.contributor}
          adapter={UD_ASSISTANT}
          documentId={subject?.kind === 'document' ? subject.id : null}
          documentName={subject?.kind === 'document' ? subject.name : null}
          focus={focus}
          onClearFocus={clearFocus}
          onApplied={subject?.onApplied}
          onFocusHere={subject?.onFocusHere}
          picker={
            projectId ? null : (
              <ProjectPicker
                client={client}
                onPick={(p) => setHeld({ projectId: p.id, projectName: p.name })}
              />
            )
          }
        />
      )}
    </div>
  );
};

export const Layout = () => (
  <AssistantSubjectProvider>
    <Shell />
  </AssistantSubjectProvider>
);
