import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams, Link } from 'react-router-dom';
import { useStrictClient } from './contexts/StrictModeContext.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { DocumentProvider } from './contexts/DocumentContext.jsx';
import { IgtDocument } from '../../domain/IgtDocument.js';
import { formatFindingsForClipboard } from '../../domain/validate.js';
import { notifyError, notifyWarning, toast, humanizeError } from '@/utils/feedback';
import { History, FileText, Type, Mic, Play, Table, Download } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { ExportDialog } from '@/components/export/ExportDialog.jsx';
import { DocumentTokenize } from './tokenize/DocumentTokenize.jsx';
import { HistoryDrawer } from './HistoryDrawer.jsx';
import { DocumentMetadata } from './metadata/DocumentMetadata.jsx';
import { DocumentBaseline } from './baseline/DocumentBaseline.jsx';
import { DocumentMedia } from './media/DocumentMedia.jsx';
import { AnalyzeIsland } from './analyze/AnalyzeIsland.jsx';
import { useDocumentPermissions } from './hooks/useDocumentPermissions.js';
import { useDocumentHistory } from './hooks/useDocumentHistory.js';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

// Renders only the active tab's panel (others stay unmounted).
const Panel = ({ active, children }) => (active ? children : null);

// Surface validateIgtDocument findings: full detail to the console (grouped),
// plus ONE consolidated "Data integrity issue detected" toast with a
// [Copy details] action that drops the lot onto the clipboard for a bug report.
// Findings are things we could NOT auto-repair; healed repairs get their own
// "Document repaired" toast separately.
const reportIntegrityFindings = (findings, documentId) => {
  if (!findings?.length) return;
  console.group(`[plaid-igt] Document integrity findings (${findings.length})`);
  findings.forEach(f =>
    (f.severity === 'error' ? console.error : console.warn)(`[${f.code}] ${f.message}`, f.context));
  console.groupEnd();

  const errors = findings.filter(f => f.severity === 'error');
  const headline = errors.length ? errors : findings;
  const reason = headline.length === 1
    ? headline[0].message
    : `${headline.length} issues found — see the browser console for details.`;
  const detail = formatFindingsForClipboard(findings, { documentId });
  toast.warning('Data integrity issue detected', {
    description: reason,
    duration: Infinity,
    action: {
      label: 'Copy details',
      onClick: () => navigator.clipboard?.writeText(detail).catch(() => {}),
    },
  });
};

const DocumentEditor = () => {
  const { projectId, documentId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const client = useStrictClient();
  const { logout } = useAuth();
  const [searchParams] = useSearchParams();
  // Deep-link params (so a fresh tab — where router state isn't available —
  // still lands on the right tab + sentence): ?tab=analyze&focusSentence=<id>.
  const tabParam = searchParams.get('tab');
  const focusParam = searchParams.get('focusSentence');

  // Seed the Analyze island's focus key from ?focusSentence= once; the island
  // consumes + clears it (StrictMode-aware). Done in render so it's set before
  // the island child mounts.
  const focusSeededRef = useRef(false);
  if (!focusSeededRef.current && focusParam) {
    focusSeededRef.current = true;
    try {
      sessionStorage.setItem('igt:focus-sentence', JSON.stringify({ docId: documentId, sentenceId: focusParam }));
    } catch { /* noop */ }
  }

  // The single shared IgtDocument for the whole editor. `asOf` drives time-travel:
  // selecting a history entry reloads this doc at that snapshot.
  const [doc, setDoc] = useState(null);
  const [asOf, setAsOf] = useState(null);
  // Search/concordance click-through (and anything else navigating here) can
  // request an initial tab via router state or the ?tab= query param.
  const [activeTab, setActiveTab] = useState(location.state?.tab ?? tabParam ?? 'metadata');
  const [loadError, setLoadError] = useState('');
  const [exportOpen, setExportOpen] = useState(false);

  const permissions = useDocumentPermissions(doc?.project);
  const history = useDocumentHistory(documentId, client);

  useDocumentTitle(doc?.document?.name, doc?.project?.name);

  useEffect(() => {
    if (!client) {
      logout();
      return undefined;
    }
    let cancelled = false;
    setDoc(null);
    setLoadError('');
    (async () => {
      try {
        const d = await IgtDocument.load(client, projectId, documentId, asOf);
        if (cancelled) return;
        d.onError = (msg) => notifyError(humanizeError(msg, msg));
        setDoc(d);
      } catch (e) {
        if (cancelled) return;
        if (e.message === 'Not authenticated' || e.status === 401) {
          logout();
          return;
        }
        console.error('Failed to load document:', e);
        setLoadError(humanizeError(e, 'This document could not be loaded.'));
      }
    })();
    return () => { cancelled = true; };
  }, [client, projectId, documentId, asOf, navigate]);

  // Reconcile: heal IGT invariants in the shared substrate — every word token
  // must have a full-width morpheme, and no morpheme may be orphaned. This runs
  // (a) once when the document loads (to repair what another app, e.g. UD, may
  // have left), and (b) every time the user enters the Analyze tab. The
  // analyze-entry re-run is essential: word tokens created in the Tokenize tab
  // this session have no morpheme yet, and tokenization never creates one — only
  // reconcile does. Without it, freshly-tokenized words show empty "Morphemes"
  // rows until a full page reload. Edit permission only, not while time-travelling
  // (asOf is a read-only snapshot). Idempotent + single-flighted, so re-entry is
  // a cheap no-op when nothing needs healing.
  const reconciledDocRef = useRef(null);
  useEffect(() => {
    if (!doc || asOf || !permissions?.canWrite) return undefined;
    const isInitial = reconciledDocRef.current !== doc;
    // After the initial pass, only re-reconcile on Analyze entry.
    if (!isInitial && activeTab !== 'analyze') return undefined;
    reconciledDocRef.current = doc;
    let cancelled = false;
    (async () => {
      try {
        const {
          created = 0, deleted = 0, deletedAnnotatedOrphans = 0, dedupedSpans = 0, findings = [], error,
        } = await doc.reconcileOnOpen();
        if (cancelled) return;
        if (error) {
          notifyError(
            'Could not finish auto-repairing this document; some morphemes may be missing or out of sync. Try reloading.',
            'Repair failed'
          );
          return;
        }
        // Surface genuinely surprising repairs (orphan-morpheme deletes /
        // duplicate-span merges). Adding a default morpheme per bare word is
        // routine scaffolding (e.g. right after tokenizing), so it stays silent.
        // Don't assert "another app" — the most common trigger is IGT's own
        // word merge (which reparents both words' spans onto the survivor); only
        // make the toast sticky when real annotation data was dropped.
        if (deleted + dedupedSpans > 0) {
          const parts = [];
          if (created) parts.push(`added ${created} default morpheme${created === 1 ? '' : 's'}`);
          if (deleted) {
            let s = `removed ${deleted} orphaned morpheme${deleted === 1 ? '' : 's'} (matching no word)`;
            if (deletedAnnotatedOrphans) {
              s += ` — ${deletedAnnotatedOrphans} carried annotations, recoverable via document history`;
            }
            parts.push(s);
          }
          if (dedupedSpans) {
            parts.push(`merged ${dedupedSpans} duplicate annotation${dedupedSpans === 1 ? '' : 's'} from a token merge (values joined with ' | ' — review them)`);
          }
          const droppedData = deletedAnnotatedOrphans > 0;
          notifyWarning(
            `Repaired this document on open: ${parts.join('; ')}.${droppedData ? ' Please review.' : ''}`,
            'Document repaired',
            droppedData ? { duration: Infinity } : undefined
          );
        }
        // Integrity findings (things we could NOT auto-repair) — console + toast.
        // Only on the initial pass per doc, so re-entering Analyze doesn't
        // re-toast the same pre-existing, un-healable issues.
        if (isInitial) reportIntegrityFindings(findings, doc.id);
      } catch (e) {
        console.error('Reconcile failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [doc, asOf, permissions?.canWrite, activeTab]);

  // The built-in analysis helpers (copy prior analyses + auto-link) no longer
  // run automatically — they were disruptive mid-editing. They run on demand
  // from the interlinear Auto-link dialog (see AutoLinkDialog + autoPass.js).

  // The interlinear island is framework-agnostic; its empty-state CTA asks to
  // switch tabs via a DOM event rather than reaching into the router.
  useEffect(() => {
    const onNav = (e) => { const t = e.detail?.tab; if (t) setActiveTab(t); };
    window.addEventListener('igt:navigate-tab', onNav);
    return () => window.removeEventListener('igt:navigate-tab', onNav);
  }, []);

  // Land on Analyze when the document is already tokenized — the work surface
  // shouldn't be buried behind Metadata. Once, on the first live load only (not
  // on time-travel reloads or after the user has navigated tabs themselves).
  const didAutoTabRef = useRef(!!(location.state?.tab || tabParam)); // explicit tab request wins over auto-tab
  useEffect(() => {
    if (!doc || asOf || didAutoTabRef.current) return;
    didAutoTabRef.current = true;
    try {
      if ((doc.sentences || []).some((s) => s.tokens.length > 0)) setActiveTab('analyze');
    } catch { /* derivation not ready; leave default */ }
  }, [doc, asOf]);

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
        <div className={`mx-auto px-4 py-8 ${activeTab === 'analyze' ? 'max-w-[1700px]' : 'max-w-5xl'}`}>
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

            <div className="flex items-start justify-between gap-4">
              <h1 className="text-3xl font-bold tracking-tight">{doc.document.name}</h1>
              <Button variant="outline" onClick={() => setExportOpen(true)}>
                <Download className="h-4 w-4" /> Export
              </Button>
            </div>

            <ExportDialog
              open={exportOpen}
              onOpenChange={setExportOpen}
              client={client}
              project={doc.project}
              defaultScope={{ type: 'document', id: doc.id, name: doc.document.name }}
              canSavePresets={permissions.canManage && !isViewingHistorical}
              asOf={asOf}
            />

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
