import { HistoryDrawer } from './HistoryDrawer.jsx';
import { RestoreDialog } from './RestoreDialog.jsx';

/**
 * A document's history drawer and the restore it leads to, as every app's
 * document screen mounts them: once, above the tabs, so History works from
 * every tab.
 *
 * `history` is what `useHistoryView` returns. `raw` is the LIVE document's,
 * which the restore compares the past state against. `canRestore` is the app's
 * (maintainers, and never while a service run is writing). `roleWords` and
 * `layerWords` name the app's layers in the restore's list of changes.
 */
export const DocumentHistoryPanel = ({
  history,
  client,
  documentId,
  raw,
  canRestore,
  roleWords,
  layerWords,
}) => (
  <>
    <HistoryDrawer
      isOpen={history.drawerOpen}
      onClose={history.closeHistory}
      auditEntries={history.auditEntries}
      loading={history.loadingAudit}
      error={history.historyError}
      onSelectEntry={history.selectEntry}
      selectedEntry={history.selectedEntry}
      canRestore={canRestore}
      onRestore={history.setRestoreEntry}
      onLoadMoreOps={history.loadMoreOps}
      loadingMoreOps={history.loadingMoreOps}
    />
    <RestoreDialog
      open={!!history.restoreEntry}
      onOpenChange={(o) => {
        if (!o) history.setRestoreEntry(null);
      }}
      client={client}
      documentId={documentId}
      raw={raw}
      roleWords={roleWords}
      layerWords={layerWords}
      entry={history.restoreEntry}
      onRestored={history.handleRestored}
    />
  </>
);
