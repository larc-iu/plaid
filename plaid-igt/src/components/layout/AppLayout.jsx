import { useCallback, useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { UserButton } from './UserButton';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '@ui/components/ui/button';
import { cn } from '@ui/lib/utils';
import { AssistantDock } from '@ui/components/assistant/AssistantDock.jsx';
import { AssistantMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { ProjectPicker } from '@ui/components/assistant/ProjectPicker.jsx';
import { useDockWidth } from '@ui/components/assistant/useDock.js';
import { AssistantSubjectProvider } from '@ui/components/assistant/AssistantSubject.jsx';
import { useAssistantScope } from '@ui/components/assistant/subject.js';
import { readDockOpen, saveDockOpen } from '@ui/components/assistant/panelWidth.js';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { IGT_ASSISTANT } from '../projects/assistant/adapter.js';

// shadcn shell frame, and the one place the assistant panel is mounted.
// Preflight is global now, and the two islands own their CSS and must not
// inherit the scoped preflight reset.
//
// This is a LAYOUT route: it mounts once and the screens swap inside its
// `Outlet`. Every route used to wrap its own copy of this, which meant the
// shell's survival across a navigation was incidental, and a panel living in it
// could not hold a conversation from one screen to the next.
//
// The panel's project comes from whatever screen published a subject, and the
// LAST one seen is kept when the reader walks onto a screen that has none
// (/vocabularies, /admin, /profile). The assistant is per project all the way
// down (discovery, the conversation records, the agent's workspace), so
// "always available" can only mean the panel keeps the thread it has rather
// than becoming a project-less chat, which would be a chat with 2 of its 64
// tools.

const Shell = () => {
  const { user, client, logout } = useAuth();
  const location = useLocation();
  const subject = useAssistantScope();

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
  const projectName = project?.projectName || null;
  const available = useAssistantAvailable(client, projectId, IGT_ASSISTANT.app);
  // Whether to offer the picker: only where no project is in scope AND the
  // route is not itself under a project. The route test is what keeps the
  // picker off the new-project wizard and the importers, which publish no
  // subject and have no annotation to ask about. It is NOT there for the first
  // paint of a document screen: `projectId` on those comes from the route
  // params, so it is published by the first effect and there is nothing to
  // flicker. (Only `projectName` waits on the document load.)
  const routeHasProject = /^\/projects\/[^/]+/.test(location.pathname);
  const offerPicker = !projectId && !routeHasProject;

  // What the reader pointed at, as {ref, label}. The interlinear grid is a lit
  // island, so its "Ask" reaches React as a window event. The shell listens
  // rather than the document screen: the panel lives here now, and Ask has to
  // be able to open it.
  const [focus, setFocus] = useState(null);
  useEffect(() => {
    const onAsk = (e) => {
      if (!e.detail) return;
      setFocus(e.detail);
      setDockOpen(true);
    };
    window.addEventListener('igt:ask-assistant', onAsk);
    return () => window.removeEventListener('igt:ask-assistant', onAsk);
  }, [setDockOpen]);
  // A reference into a document the reader has since left means nothing, so it
  // does not travel with them.
  useEffect(() => {
    setFocus(null);
  }, [subject?.id]);

  const navItem = (to, label, active) => (
    <Link
      key={to}
      to={to}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {label}
    </Link>
  );

  return (
    <div
      className="min-h-screen bg-background text-foreground"
      style={{ paddingRight: shown ? width : undefined }}
    >
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link to="/projects" className="font-bold">
            Plaid IGT
          </Link>
          <nav className="flex items-center gap-1">
            {navItem('/projects', 'Projects', location.pathname.startsWith('/projects'))}
            {navItem(
              '/vocabularies',
              'Vocabularies',
              location.pathname.startsWith('/vocabularies'),
            )}
            {user?.isAdmin && navItem('/admin', 'Admin', location.pathname.startsWith('/admin'))}
            {/* The user guide is published with the docs site, not bundled here. */}
            <a
              href="https://larc-iu.github.io/plaid/igt-guide.html"
              target="_blank"
              rel="noreferrer"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              Guide
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {/* Offered wherever there is a project for it to be about, which
                includes the one the panel is holding, and only when an
                assistant is actually online there: a control that opens an
                empty panel is worse than no control. `available` is null until
                that is known, which is also not offered, and it answers from a
                per-project cache so a navigation does not flicker it away and
                back. Not offered in a window too narrow to give it width. */}
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
            {user && <UserButton user={user} client={client} onLogout={logout} />}
          </div>
        </div>
      </header>
      <main>
        <Outlet />
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
          adapter={IGT_ASSISTANT}
          documentId={subject?.kind === 'document' ? subject.id : null}
          documentName={subject?.kind === 'document' ? subject.name : null}
          lexiconId={subject?.kind === 'lexicon' ? subject.id : null}
          lexiconName={subject?.kind === 'lexicon' ? subject.name : null}
          focus={focus}
          onClearFocus={() => setFocus(null)}
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

export function AppLayout() {
  return (
    <AssistantSubjectProvider>
      <Shell />
    </AssistantSubjectProvider>
  );
}
