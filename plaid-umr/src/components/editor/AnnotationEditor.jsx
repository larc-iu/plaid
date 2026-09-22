import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { History, Info } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { useHistoryView } from '@ui/hooks/useHistoryView.js';
import { HistoricalBanner } from '@ui/components/shared/HistoricalBanner.jsx';
import { HistoryDrawer, HISTORY_DRAWER_WIDTH } from '@ui/components/shared/HistoryDrawer';
import { RestoreDialog } from '@ui/components/shared/RestoreDialog.jsx';
import { useReconcileOnOpen } from '@ui/hooks/useReconcileOnOpen.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { canEditProject, canManageProject } from '@ui/domain/permissions.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useDocumentEditor } from '@ui/hooks/useDocumentEditor.js';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { TOKEN_ROLE_WORDS, UMR_LAYER_WORDS } from '../../domain/restoreSummary.js';
import { UmrCanvas } from './annotation/UmrCanvas.jsx';
import { DraftDialog } from './services/DraftDialog.jsx';

// The document's annotation page: the frame around the graph editor. The
// canvas replaces SentenceList below; everything else here (history, restore,
// the read-only banner, the setup guard) is the frame it goes in.
export const AnnotationEditor = () => {
  // Project, document, the breadcrumbs/tab strip and the version-counter
  // subscription all come from DocumentEditorShell, which guarantees both the
  // project and the document are loaded before this renders.
  const {
    projectId,
    documentId,
    doc,
    project,
    reload,
    services,
    writeLockHeld,
    setChromeOffset,
    setChromeBusy,
    focusNonce = 0,
  } = useDocumentEditor();
  const { getClient, logout, user } = useAuth();
  // The deep link: ?sent=<sentence number>, and ?var= for one of its nodes.
  // The canvas answers it, since the block may be on another page.
  const [searchParams] = useSearchParams();
  const sentParam = searchParams.get('sent');
  const varParam = searchParams.get('var');

  useDocumentTitle('Annotate', doc?.name, project?.name);

  // The history drawer, the entry being viewed, and the restore it can lead to.
  const {
    drawerOpen,
    openHistory,
    closeHistory,
    selectedEntry,
    selectEntry,
    asOf,
    snapshot,
    loadingSnapshot,
    auditEntries,
    loadingAudit,
    historyError,
    restoreEntry,
    setRestoreEntry,
    handleRestored,
  } = useHistoryView({ documentId, client: getClient(), doc, reload, onExpired: logout });

  // The initial repair, and the gate the body holds behind a spinner while it
  // runs. Strict mode is entered here once there are edits to guard.
  const reconciling = useReconcileOnOpen({
    doc,
    asOf,
    canWrite: canEditProject(project, user),
  });

  // Lock the shell's tab strip for as long as the body is a spinner: a tab
  // switch mid-repair would leave the repair writing under a screen that has
  // moved on.
  useEffect(() => {
    setChromeBusy(reconciling);
    return () => setChromeBusy(false);
  }, [reconciling, setChromeBusy]);

  // The history drawer pushes content right rather than overlaying it. The
  // breadcrumbs and tab strip live in DocumentEditorShell, so tell it to move
  // with us, and put it back when we leave the tab.
  useEffect(() => {
    setChromeOffset(drawerOpen ? HISTORY_DRAWER_WIDTH : 0);
    return () => setChromeOffset(0);
  }, [drawerOpen, setChromeOffset]);

  // What is on screen: the snapshot a history entry named, or the live
  // document. Handlers are nulled from the click on an entry, so no mutation
  // reaches either.
  const shown = snapshot ?? doc;
  const activeDocument = shown?.raw;

  // Read-only mode is on when the user lacks write access to the project OR
  // when time-travelling. Key the historical case on `selectedEntry`, not
  // `isViewingHistorical`: the entry is set the instant you click (and the
  // banner appears), but `isViewingHistorical` only flips AFTER the async
  // as-of fetch resolves. Using it would leave a window where the banner says
  // "historical" yet the live handlers are still wired.
  const canEdit = canEditProject(project, user);
  const readOnly = !canEdit || !!selectedEntry || !!writeLockHeld;

  const toolbar = (
    <div className="mt-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Button variant="secondary" className="gap-2" onClick={openHistory}>
          <History className="h-4 w-4" />
          History
        </Button>
        {/* A draft rewrites the document, so it is offered only to someone who
            may write and only over the live state. */}
        {canEdit && !selectedEntry && (
          <DraftDialog
            draft={services.draft}
            isDiscovering={services.isDiscovering}
            writeLockHeld={writeLockHeld}
          />
        )}
      </div>

      <div className="flex items-center gap-3">
        {selectedEntry && <Button onClick={closeHistory}>Return to current</Button>}
      </div>
    </div>
  );

  // Persistent read-only banner, shown whenever editing is disabled, either
  // because the user only has viewer access or because they are viewing a past
  // state. The message names the reason so it is not mysterious. For time
  // travel this is the sole indicator, so it carries the timestamp and the
  // loading state too, and shows as soon as an entry is picked.
  const readOnlyBanner = selectedEntry ? (
    <HistoricalBanner entry={selectedEntry} loading={loadingSnapshot} className="mt-4" />
  ) : !canEdit ? (
    <div className="mt-4 flex items-center gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-900">
      <Info className="h-4 w-4 shrink-0" />
      Read-only. You have viewer access to this project.
    </div>
  ) : null;

  // Reaching the editor in an unconfigured project means a link straight to
  // this URL, since clicking into the project sends you to the setup page
  // first. Say so and offer the way there, rather than redirecting.
  //
  // Read the PROJECT's layers, never the open document's. During time travel
  // `layerInfo` is the structure as it was at that moment, which for an early
  // enough entry predates the setup and is not a statement about the project.
  if (!reconciling && project && !getUmrLayerInfo(project).isConfigured) {
    return (
      <div className="min-h-screen w-full">
        <div className="flex justify-center py-16">
          <div className="flex max-w-lg gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Not set up for UMR</p>
              {canManageProject(project, user) ? (
                <p className="mt-1">
                  This project has no UMR layers.{' '}
                  <Link
                    className="font-medium underline underline-offset-2"
                    to={`/projects/${projectId}/configuration`}
                  >
                    Set up its layers
                  </Link>
                  .
                </p>
              ) : (
                <p className="mt-1">
                  This project has no UMR layers. A project maintainer can set it up.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full">
      <HistoryDrawer
        isOpen={drawerOpen}
        onClose={closeHistory}
        auditEntries={auditEntries}
        loading={loadingAudit}
        error={historyError}
        onSelectEntry={selectEntry}
        selectedEntry={selectedEntry}
        // A restore rewrites the whole document, which is exactly what a
        // running service is doing.
        canRestore={canManageProject(project, user) && !writeLockHeld}
        onRestore={setRestoreEntry}
      />

      <RestoreDialog
        open={!!restoreEntry}
        onOpenChange={(o) => {
          if (!o) setRestoreEntry(null);
        }}
        client={getClient()}
        documentId={documentId}
        raw={doc?.raw}
        roleWords={TOKEN_ROLE_WORDS}
        layerWords={UMR_LAYER_WORDS}
        entry={restoreEntry}
        onRestored={handleRestored}
      />

      {/* Main content area, pushed right (not overlaid) when the drawer is
          open. */}
      <div
        className="min-h-screen transition-[margin-left] duration-300 ease-out"
        style={{ marginLeft: drawerOpen ? HISTORY_DRAWER_WIDTH : 0 }}
      >
        {/* Only the BODY waits here: the breadcrumbs and tab strip are the
            shell's and stay on screen throughout. */}
        {reconciling && (
          <div className="flex justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
          </div>
        )}

        {!reconciling && !activeDocument && (
          <p className="py-10 text-center text-muted-foreground">Document not found</p>
        )}

        {!reconciling && activeDocument && (
          <>
            <div className="px-6 pb-4">
              {toolbar}
              {readOnlyBanner}
            </div>

            {/* The canvas goes here. It reads the same `shown` document, so it
                draws a past state as readily as the live one. */}
            <UmrCanvas
              doc={shown}
              readOnly={readOnly}
              sentParam={sentParam}
              varParam={varParam}
              focusNonce={focusNonce}
            />
          </>
        )}
      </div>
    </div>
  );
};
