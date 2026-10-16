import { Link } from 'react-router-dom';
import { DOC_GUTTER } from '@ui/lib/pageWidth.js';
import { cpSlice } from '@larc-iu/plaid-client';
import { useStrictClient } from './contexts/StrictModeContext.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { DocumentProvider } from './contexts/DocumentContext.jsx';
import { IgtDocument } from '../../domain/IgtDocument.js';
import {
  isTokenIgnored,
  readIgnoredTokens,
  readInitialized,
  readImportState,
  importRouteFor,
} from '@/domain/igtConfig';
import { notifyError, notifyWarning } from '@/utils/feedback';
import { announceLinkConflict } from '@ui/lib/cellConflict.js';
import { DocumentEditorShell } from '@ui/components/shared/DocumentEditorShell.jsx';
import { DocumentDetailsPage } from '@ui/components/shared/DocumentDetailsPage.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { ExportRunner } from '@/components/export/ExportRunner.jsx';
import { DocumentTokenize } from './tokenize/DocumentTokenize.jsx';
import { TOKEN_ROLE_WORDS } from '@/domain/restoreSummary.js';
import { DocumentMetadata } from './metadata/DocumentMetadata.jsx';
import { DocumentBaseline } from './baseline/DocumentBaseline.jsx';
import { AnalyzeIsland } from './analyze/AnalyzeIsland.jsx';
import { Suspended } from '@ui/components/shared/Suspended';
import { lazyNamed } from '@ui/lib/lazyNamed';
import { useDocumentPermissions } from './hooks/useDocumentPermissions.js';
import { readOnlyReason } from '@ui/domain/permissions.js';
import { useSentenceFocus } from './hooks/useSentenceFocus.js';
import { useIslandTabRequests } from './hooks/useIslandTabRequests.js';
import { useComposeProject } from '@/hooks/useCompose';
import { IGT_ASSISTANT } from '../projects/assistant/adapter.js';

// The Media tab (the timeline, waveform, speech detection, and recording
// conversion) and the Comments tab ride in their own chunks.
const DocumentMedia = lazyNamed(() => import('./media/DocumentMedia.jsx'), 'DocumentMedia');
const CommentsTab = lazyNamed(() => import('./comments/CommentsTab.jsx'), 'CommentsTab');

// A document's screen: plaid-ui's shell, with what is IGT's. The tab rides in
// `?tab=` (every link to a tab of a document has always said so), and the body
// is drawn here, under one `DocumentProvider` that every tab and the Analyze
// island read.

// The tabs, in the order every app keeps: the work tabs, then Comments,
// Export, Details.
const TABS = [
  { value: 'baseline', label: 'Baseline' },
  { value: 'media', label: 'Media' },
  { value: 'tokenize', label: 'Tokenize' },
  { value: 'analyze', label: 'Analyze' },
  { value: 'comments', label: 'Comments' },
  { value: 'export', label: 'Export' },
  { value: 'details', label: 'Details' },
];

// Tabs whose body gets the whole width instead of the form-width column. Both
// are horizontally scrolling views (the interlinear editor, and the media
// timeline, whose content is `duration * pixelsPerSecond` wide with the
// container as the viewport), so every extra pixel is another slice visible
// without scrolling.
const WIDE_TABS = ['analyze', 'media'];

// Landing on Analyze when the document is already tokenized: the work surface
// shouldn't be buried behind Baseline. A document with no tokens yet has its
// work ahead of it, at Baseline.
const landing = (doc) => {
  try {
    return (doc.sentences || []).some((s) => s.tokens.length > 0) ? 'analyze' : null;
  } catch {
    // The derivation is not ready: stay on Baseline.
    return null;
  }
};

// The words the long-document notice weighs: a token the ignored-tokens rule
// excludes is text, not a word.
export const igtWordCount = (doc) => {
  const layer = doc?.layerInfo?.primaryTokenLayer;
  if (!layer?.tokens) return undefined;
  const cfg = readIgnoredTokens(layer.config);
  const body = [...(doc.body || '')];
  return layer.tokens.filter((t) => !isTokenIgnored(body.slice(t.begin, t.end).join(''), cfg))
    .length;
};

const IGT_SHELL = {
  // The user rides along for the provenance convention: a person whose work
  // the project reviews (plaid.review) is a contributor, whose edits are
  // stamped as such (IgtDocument.contributorId).
  loadDocument: ({ client, projectId, documentId, project, user }) =>
    IgtDocument.load(client, projectId, documentId, null, { user, project }),
  // A refusal the document makes before anything is sent (a guard, a check)
  // comes without a label: nothing was written, which is the fact. A link edit
  // refused because someone changed what it changes first is said as a cell's
  // conflict is: who, and what.
  onDocumentError: ({ doc, documentId, user }) => {
    const linkConflict = announceLinkConflict({
      client: doc.client,
      documentId,
      me: user?.id,
      warn: (message) => notifyWarning(message),
    });
    return (msg, err, label) =>
      err?.linkConflict
        ? linkConflict(err.linkConflict)
        : notifyError(err ?? msg, label ?? 'Not changed');
  },
  assistantApp: IGT_ASSISTANT.app,
  documentPath: (projectId, documentId) => `/projects/${projectId}/documents/${documentId}`,
  tabs: {
    list: TABS,
    editor: 'analyze',
    wide: WIDE_TABS,
    // Comments hang live threads on the document, so a past state has none.
    past: TABS.map((t) => t.value).filter((t) => t !== 'comments'),
    long: ['baseline', 'analyze'],
    // Details was called Metadata, and a link saved then still opens it.
    query: { fallback: 'baseline', aliases: { metadata: 'details' }, landing },
  },
  renderTab: (tab, context) => <DocumentBody tab={tab} context={context} />,
  // The repair on open is about the document, whatever tab it opens on.
  reconcileOnOpen: true,
  // The Analyze grid says how its saves are going itself.
  saveStatus: false,
  roleWords: TOKEN_ROLE_WORDS,
  // The morphemes a restore brought back take the types their entries go by
  // now (writeEntryTypes).
  afterRestore: async (doc) => {
    await doc?.reload();
    await doc?.writeEntryTypes();
  },
  // Landing on a sentence: the ?focusSentence= handoff, and a citation asking
  // for one of this document's sentences while the reader is on the grid.
  useFocusHere: useSentenceFocus,
  sentenceRef: (sentence, i) => `s${i + 1}`,
  // A token carries `content`, not the running text, so the hint is cut from
  // the body by the sentence's own offsets. Code points, like every offset in
  // this app.
  sentenceHint: (sentence, doc) => cpSlice(doc?.body || '', sentence.begin, sentence.end),
  wordCount: (doc) => igtWordCount(doc),
};

// Every write goes through a client in strict mode for this document
// (StrictModeProvider), so a stale write is refused instead of clobbering.
export const DocumentDetail = () => (
  <DocumentEditorShell app={IGT_SHELL} client={useStrictClient()} />
);

// What a project with nothing safe to open in it says in place of a tab.
const Gate = ({ children }) => (
  <div role="status" className="mt-2 rounded-md border bg-muted px-4 py-3 text-sm">
    {children}
  </div>
);

// The body under the shell's chrome, whichever tab is open. It stays mounted
// across a tab switch, since it is the same component in the same place.
const DocumentBody = ({ tab, context }) => {
  const {
    projectId,
    client,
    doc,
    project,
    asOf,
    pastEntry,
    comments,
    writeLockHeld,
    acquireWriteLock,
    assistantAvailable,
    goToTab,
  } = context;
  const { user } = useAuth();
  const permissions = useDocumentPermissions(project);
  // A code bound under Settings applies in the grid and every other field here.
  useComposeProject(project);
  // The island asks for a tab by a window event, having no router to reach.
  useIslandTabRequests(goToTab);
  const isViewingHistorical = !!asOf;

  // A project whose import never finished sends its maintainers back to the
  // wizard, and the resume DELETES the documents it did not complete.
  // Annotating one of them would be work thrown away.
  const unfinishedImport = readImportState(project?.config);
  if (unfinishedImport) {
    const to = importRouteFor(unfinishedImport.kind);
    return (
      <Gate>
        The {unfinishedImport.kind} import
        {unfinishedImport.source ? ` of “${unfinishedImport.source}”` : ''} did not finish.{' '}
        {permissions.canManage && to ? (
          <Link className="underline" to={`${to}?resume=${projectId}`}>
            Finish it
          </Link>
        ) : (
          'A project maintainer can finish it.'
        )}
      </Gate>
    );
  }

  // Reaching a document in a project never set up for IGT means a link
  // straight to this URL: the project door (ProjectDetail) sends a maintainer
  // to the setup wizard before they can get here. Say so and offer the way
  // there rather than redirecting, and rather than handing over an editor
  // whose fields and orthographies were never configured.
  if (!readInitialized(project?.config)) {
    return (
      <Gate>
        {permissions.canManage ? (
          <>
            This project is not set up for IGT.{' '}
            <Link className="underline" to={`/projects/${projectId}/setup`}>
              Set it up
            </Link>
            .
          </>
        ) : (
          <>This project is not set up for IGT. A project maintainer can set it up.</>
        )}
      </Gate>
    );
  }

  // A service run writing to this document takes the editor read-only for as
  // long as it writes: the run outlives its dialog, and it ends in a reload
  // that would discard anything typed underneath it. See useWriteLock.
  // Read-only from the click on a history entry, not from the snapshot landing:
  // nothing may land on the live document in the window between.
  const readOnly = permissions.isReadOnly || !!pastEntry || !!writeLockHeld;
  // The wide tabs run to the window's edge, and take the chrome's inset.
  const inset = WIDE_TABS.includes(tab) ? DOC_GUTTER : undefined;

  return (
    <DocumentProvider
      value={{
        doc,
        client,
        readOnly,
        asOf,
        comments,
        // Whether this user may edit at all, ignoring any run in flight. What
        // gates a run's own controls, so the button carrying its progress does
        // not vanish the moment the run starts. Off from the click on a
        // history entry, as readOnly is, and as the shared shell keys it for
        // ud and umr: not from the snapshot landing.
        canWrite: permissions.canWrite && !pastEntry,
        canManage: permissions.canManage,
        writeLock: writeLockHeld,
        acquireWriteLock,
        assistantOnline: !!assistantAvailable,
        // How a tab sends the reader to another tab. The window event the
        // island uses stays the island's: it is not React and has no context
        // to read.
        goToTab,
      }}
    >
      {!isViewingHistorical && permissions.isReadOnly && (
        <div className={inset}>
          <Notice tone="info" className="mb-4">
            <p className="font-medium">Read-only</p>
            <p className="text-xs">{readOnlyReason(project, user)}</p>
          </Notice>
        </div>
      )}

      {/* Only the active tab's body is mounted. */}
      <div className={inset ? `pt-2 ${inset}` : 'pt-2'}>
        {tab === 'baseline' && <DocumentBaseline />}
        {tab === 'media' && (
          <Suspended>
            <DocumentMedia />
          </Suspended>
        )}
        {tab === 'tokenize' && <DocumentTokenize />}
        {tab === 'analyze' && <AnalyzeIsland />}
        {tab === 'comments' && (
          <Suspended>
            <CommentsTab />
          </Suspended>
        )}
        {tab === 'export' && (
          <div className="flex flex-col gap-6 pt-4">
            <div className="rounded-lg border bg-card p-4">
              <ExportRunner
                client={client}
                project={project}
                defaultScope={{ type: 'document', id: doc.id, name: doc.document.name }}
                canManage={permissions.canManage}
                asOf={asOf}
              />
            </div>
          </div>
        )}
        {tab === 'details' && <DocumentDetailsPage metadata={DocumentMetadata} context={context} />}
      </div>
    </DocumentProvider>
  );
};
