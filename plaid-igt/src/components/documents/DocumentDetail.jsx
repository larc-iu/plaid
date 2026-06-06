import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useStrictClient } from './contexts/StrictModeContext.jsx';
import { DocumentProvider } from './contexts/DocumentContext.jsx';
import { IgtDocument } from '../../domain/IgtDocument.js';
import { notifyError, notifyWarning } from '@/utils/feedback';
import { History, FileText, Type, Mic, Play, Table } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { DocumentTokenize } from './tokenize/DocumentTokenize.jsx';
import { HistoryDrawer } from './HistoryDrawer.jsx';
import { DocumentMetadata } from './metadata/DocumentMetadata.jsx';
import { DocumentBaseline } from './baseline/DocumentBaseline.jsx';
import { DocumentMedia } from './media/DocumentMedia.jsx';
import { AnalyzeIsland } from './analyze/AnalyzeIsland.jsx';
import { useDocumentPermissions } from './hooks/useDocumentPermissions.js';
import { useDocumentHistory } from './hooks/useDocumentHistory.js';

// Renders only the active tab's panel (others stay unmounted).
const Panel = ({ active, children }) => (active ? children : null);

const DocumentEditor = () => {
  const { projectId, documentId } = useParams();
  const navigate = useNavigate();
  const client = useStrictClient();

  // The single shared IgtDocument for the whole editor. `asOf` drives time-travel:
  // selecting a history entry reloads this doc at that snapshot.
  const [doc, setDoc] = useState(null);
  const [asOf, setAsOf] = useState(null);
  const [activeTab, setActiveTab] = useState('metadata');
  const [loadError, setLoadError] = useState('');

  const permissions = useDocumentPermissions(doc?.project);
  const history = useDocumentHistory(documentId, client);

  useEffect(() => {
    if (!client) {
      navigate('/login');
      return undefined;
    }
    let cancelled = false;
    setDoc(null);
    setLoadError('');
    (async () => {
      try {
        const d = await IgtDocument.load(client, projectId, documentId, asOf);
        if (cancelled) return;
        d.onError = (msg) => notifyError(msg);
        setDoc(d);
      } catch (e) {
        if (cancelled) return;
        if (e.message === 'Not authenticated' || e.status === 401) {
          navigate('/login');
          return;
        }
        console.error('Failed to load document:', e);
        setLoadError(e.message || 'Failed to load document');
      }
    })();
    return () => { cancelled = true; };
  }, [client, projectId, documentId, asOf, navigate]);

  // Reconcile-on-open: once the document and the user's permissions are known,
  // heal IGT invariants another app may have broken in the shared substrate
  // (e.g. a word UD created that has no morpheme, or an orphaned morpheme left
  // by a word edit). Edit permission only, and not while time-travelling (asOf
  // is a read-only snapshot). Loud + recoverable. Idempotent, so it is safe to
  // re-run; it no-ops when there is nothing to repair.
  useEffect(() => {
    if (!doc || asOf || !permissions?.canWrite) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { created = 0, deleted = 0 } = await doc.reconcileOnOpen();
        if (cancelled || created + deleted === 0) return;
        const parts = [];
        if (created) parts.push(`added ${created} default morpheme${created === 1 ? '' : 's'}`);
        if (deleted) parts.push(`removed ${deleted} orphaned morpheme${deleted === 1 ? '' : 's'}`);
        notifyWarning(
          `Repaired this document after an edit in another app: ${parts.join(' and ')}. Please review.`,
          'Document repaired'
        );
      } catch (e) {
        console.error('Reconcile-on-open failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [doc, asOf, permissions?.canWrite]);

  const handleOpenHistory = () => {
    history.setOpen(true);
    if (!history.hasLoadedAudit) history.fetchAuditLog();
  };

  const handleSelectHistoryEntry = (entry) => {
    history.setSelectedEntry(entry);
    setAsOf(entry ? entry.time : null);
  };

  const handleCloseHistory = () => {
    history.setOpen(false);
    if (history.selectedEntry) handleSelectHistoryEntry(null);
  };

  if (loadError) {
    return (
      <div className="tw mx-auto max-w-5xl px-4 py-8">
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {loadError}
        </div>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="tw flex items-center justify-center py-24 text-muted-foreground">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  const isViewingHistorical = asOf != null;
  const readOnly = permissions.isReadOnly || isViewingHistorical;

  return (
    <>
      <HistoryDrawer
        isOpen={history.open}
        onClose={handleCloseHistory}
        auditEntries={history.auditEntries}
        loading={history.loadingAudit}
        error={history.error}
        onSelectEntry={handleSelectHistoryEntry}
        selectedEntry={history.selectedEntry}
      />

      {/* History rail trigger (left edge) */}
      {!history.open && (
        <button
          type="button"
          onClick={handleOpenHistory}
          aria-label="Open history"
          className="tw group fixed left-0 top-1/2 z-[1000] flex h-28 w-1.5 -translate-y-1/2 items-center justify-center rounded-r-md bg-neutral-400 transition-all hover:w-10 hover:bg-neutral-600"
        >
          <History className="h-4 w-4 text-white opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}

      <div
        className="transition-[margin] duration-200"
        style={{ marginLeft: history.open ? '400px' : '0', minHeight: '100vh' }}
      >
        <div className="mx-auto max-w-5xl px-4 py-8">
          <div className="tw">
            <nav className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Link to="/projects" className="hover:text-foreground">Projects</Link>
              <span>/</span>
              <Link to={`/projects/${projectId}`} className="hover:text-foreground">
                {doc.project?.name || 'Project'}
              </Link>
              <span>/</span>
              <span className="text-foreground">{doc.document?.name || 'Document'}</span>
            </nav>

            <h1 className="text-3xl font-bold tracking-tight">{doc.document.name}</h1>
            <p className="mb-2 mt-1 text-xs text-muted-foreground">{doc.document.id}</p>

            {isViewingHistorical && (
              <div className="mb-4 rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                <p className="font-medium">Viewing Historical State</p>
                <p className="text-xs">Changes cannot be made while viewing historical data.</p>
              </div>
            )}

            {!isViewingHistorical && permissions.isReadOnly && (
              <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <p className="font-medium">Read-only access</p>
                <p className="text-xs">You have viewer access to this project, so changes are disabled.</p>
              </div>
            )}
          </div>

          <DocumentProvider value={{ doc, client, readOnly, asOf }}>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="tw">
                <TabsTrigger value="metadata"><FileText className="h-4 w-4" /> Metadata</TabsTrigger>
                <TabsTrigger value="baseline"><Type className="h-4 w-4" /> Baseline</TabsTrigger>
                <TabsTrigger value="media"><Mic className="h-4 w-4" /> Media</TabsTrigger>
                <TabsTrigger value="tokenize"><Play className="h-4 w-4" /> Tokenize</TabsTrigger>
                <TabsTrigger value="analyze"><Table className="h-4 w-4" /> Analyze</TabsTrigger>
              </TabsList>

              <TabsContent value="metadata">
                <Panel active={activeTab === 'metadata'}><DocumentMetadata /></Panel>
              </TabsContent>
              <TabsContent value="baseline">
                <Panel active={activeTab === 'baseline'}><DocumentBaseline /></Panel>
              </TabsContent>
              <TabsContent value="media">
                <Panel active={activeTab === 'media'}><DocumentMedia /></Panel>
              </TabsContent>
              <TabsContent value="tokenize">
                <Panel active={activeTab === 'tokenize'}><DocumentTokenize /></Panel>
              </TabsContent>
              <TabsContent value="analyze">
                <Panel active={activeTab === 'analyze'}><AnalyzeIsland /></Panel>
              </TabsContent>
            </Tabs>
          </DocumentProvider>
        </div>
      </div>
    </>
  );
};

// Key the editor by documentId so navigating between documents remounts it with
// fresh state — otherwise the history rail (audit log / hasLoadedAudit) and the
// time-travel asOf/activeTab would leak from the previous document (e.g. doc B
// loading at doc A's snapshot).
export const DocumentDetail = () => {
  const { documentId } = useParams();
  return <DocumentEditor key={documentId} />;
};
