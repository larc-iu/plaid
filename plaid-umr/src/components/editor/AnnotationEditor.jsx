import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { useReconcileOnOpen } from '@ui/hooks/useReconcileOnOpen.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { canEditProject, canManageProject } from '@ui/domain/permissions.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useDocumentEditor } from '@ui/hooks/useDocumentEditor.js';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { UmrCanvas } from './annotation/UmrCanvas.jsx';
import { DraftDialog } from './services/DraftDialog.jsx';

// The document's annotation page: the frame around the graph editor. The
// canvas replaces SentenceList below; everything else here (the read-only
// notice, the setup guard) is the frame it goes in. History is the shell's.
export const AnnotationEditor = () => {
  // Project, document, the breadcrumbs/tab strip and the version-counter
  // subscription all come from DocumentEditorShell, which guarantees both the
  // project and the document are loaded before this renders. So does history:
  // `shown` is what the shell has on screen, the snapshot a history entry
  // named or the live document (`doc`).
  const {
    projectId,
    documentId,
    doc: shown,
    liveDoc: doc,
    pastEntry: selectedEntry,
    asOf,
    project,
    services,
    writeLockHeld,
    setChromeBusy,
    focusNonce = 0,
    comments,
    canComment,
    canDeleteAnyComment,
  } = useDocumentEditor();
  const { getClient, user } = useAuth();
  // The deep link: ?sent=<sentence number>, and ?var= for one of its nodes.
  // The canvas answers it, since the block may be on another page.
  const [searchParams] = useSearchParams();
  const sentParam = searchParams.get('sent');
  const varParam = searchParams.get('var');

  useDocumentTitle('Annotate', doc?.name, project?.name);

  // The initial repair, and the gate the body holds behind a spinner while it
  // runs. Strict mode OCC-guards annotation edits, as in plaid-ud: every write
  // carries the document's version, so an edit made over another person's
  // newer one is refused with a 409 and the page resyncs, where it silently
  // overwrote theirs (or minted a variable they had just taken). It is entered
  // only AFTER the repair's own writes have landed, before the canvas opens.
  const reconciling = useReconcileOnOpen({
    doc,
    asOf,
    canWrite: canEditProject(project, user),
    onRepaired: () => getClient()?.enterStrictMode(documentId),
  });
  // Strict mode is client-GLOBAL, so it is exited on the way out of this tab,
  // or it leaks onto unrelated writes (a copy on Details, a rename) with a
  // stale document-version and spurious 409s.
  useEffect(() => () => getClient()?.exitStrictMode(), [documentId, getClient]);

  // Lock the shell's tab strip for as long as the body is a spinner: a tab
  // switch mid-repair would leave the repair writing under a screen that has
  // moved on.
  useEffect(() => {
    setChromeBusy(reconciling);
    return () => setChromeBusy(false);
  }, [reconciling, setChromeBusy]);

  const activeDocument = shown?.raw;

  // Read-only mode is on when the user lacks write access to the project OR
  // when time-travelling. Key the historical case on `selectedEntry`, not on
  // the snapshot: the entry is set the instant you click (and the banner
  // appears), but the snapshot lands only AFTER the async as-of fetch
  // resolves. Using it would leave a window where the banner says "historical"
  // yet the live handlers are still wired.
  const canEdit = canEditProject(project, user);
  const readOnly = !canEdit || !!selectedEntry || !!writeLockHeld;

  // A draft rewrites the document, so it is offered only to someone who may
  // write and only over the live state. History is in the tab strip.
  const toolbar = canEdit && !selectedEntry && (
    <div className="flex items-center gap-2">
      <DraftDialog
        draft={services.draft}
        isDiscovering={services.isDiscovering}
        writeLockHeld={writeLockHeld}
      />
    </div>
  );

  // Persistent read-only notice for a reader. A past state says so in the
  // shell's banner, over every tab.
  const readOnlyBanner = !selectedEntry && !canEdit && (
    <Notice tone="info" className="mt-4">
      Read-only. You have reader access to this project.
    </Notice>
  );

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
          <Notice tone="warning" className="max-w-lg p-4">
            <p className="font-medium">Not set up for UMR</p>
            {canManageProject(project, user) ? (
              <p className="mt-1">
                This project is not set up for UMR.{' '}
                <Link
                  className="font-medium underline underline-offset-2"
                  to={`/projects/${projectId}/configuration`}
                >
                  Set it up
                </Link>
                .
              </p>
            ) : (
              <p className="mt-1">
                This project is not set up for UMR. A project maintainer can set it up.
              </p>
            )}
          </Notice>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full">
      {/* Only the BODY waits here: the breadcrumbs and tab strip are the
          shell's and stay on screen throughout. */}
      {reconciling && <Loading label="Checking this document…" className="px-6" />}

      {!reconciling && !activeDocument && (
        <p className="py-10 text-center text-muted-foreground">Document not found</p>
      )}

      {!reconciling && activeDocument && (
        <>
          {(toolbar || readOnlyBanner) && (
            <div className="px-6 pb-4">
              {toolbar}
              {readOnlyBanner}
            </div>
          )}

          {/* The canvas reads the same `shown` document, so it draws a past
              state as readily as the live one. */}
          <UmrCanvas
            doc={shown}
            readOnly={readOnly}
            sentParam={sentParam}
            varParam={varParam}
            focusNonce={focusNonce}
            // Comments are about the live document: a past state shows none,
            // as in plaid-ud.
            comments={selectedEntry ? null : comments}
            canComment={canComment}
            canDeleteAnyComment={canDeleteAnyComment}
          />
        </>
      )}
    </div>
  );
};
