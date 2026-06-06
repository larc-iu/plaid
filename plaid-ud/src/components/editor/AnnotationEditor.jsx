import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Box, Group, Button, Badge, Loader, Text, Center, Alert, Stack } from '@mantine/core';
import { IconHistory, IconBolt, IconFileOff, IconInfoCircle } from '@tabler/icons-react';
import { VirtualSentenceRow } from './annotation/VirtualSentenceRow.jsx';
import { useLayerInfo } from './hooks/useLayerInfo.js';
import { useSentenceData } from './hooks/useSentenceData.js';
import { useDocumentHistory } from './hooks/useDocumentHistory.js';
import { useNlpService } from './hooks/useNlpService.js';
import { DocumentTabs } from './DocumentTabs.jsx';
import { HistoryDrawer } from './annotation/HistoryDrawer.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { useConlluDocument } from '../../domain/useConlluDocument.js';
import { notifySuccess, notifyWarning, notifyError } from '../../utils/feedback.jsx';
import { canEditProject, canManageProject } from '../../utils/permissions.js';

const DRAWER_WIDTH = 384;

// Document-wide annotation-row expansion. FEATS defaults to collapsed because its
// vertically-stacked tags inflate column widths; users expand it via its row header.
// Persisted across documents/sessions in localStorage.
const FIELD_VISIBILITY_KEY = 'ud-annotation-visible-fields';
const DEFAULT_VISIBLE_FIELDS = { lemma: true, xpos: true, upos: true, feats: false };

const loadVisibleFields = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(FIELD_VISIBILITY_KEY));
    if (saved && typeof saved === 'object') return { ...DEFAULT_VISIBLE_FIELDS, ...saved };
  } catch { /* ignore malformed/absent value */ }
  return DEFAULT_VISIBLE_FIELDS;
};

export const AnnotationEditor = () => {
  const { projectId, documentId } = useParams();
  const navigate = useNavigate();
  // History viewer state
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [selectedHistoryEntry, setSelectedHistoryEntry] = useState(null);
  const [viewingHistoricalState, setViewingHistoricalState] = useState(false);

  // Long-lived current document + ambient component state.
  const [doc, setDoc] = useState(null);
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const { getClient, user } = useAuth();

  // Which annotation rows are expanded (document-wide). Persisted to localStorage.
  const [visibleFields, setVisibleFields] = useState(loadVisibleFields);
  useEffect(() => {
    try { localStorage.setItem(FIELD_VISIBILITY_KEY, JSON.stringify(visibleFields)); } catch { /* ignore */ }
  }, [visibleFields]);
  const handleToggleField = useCallback((field) => {
    setVisibleFields((prev) => ({ ...prev, [field]: !prev[field] }));
  }, []);

  useConlluDocument(doc);

  const fetchData = async (initial) => {
    if (!projectId || !documentId) return;
    const client = getClient();
    if (!client) {
      window.location.href = '/login';
      return;
    }
    try {
      if (initial) setLoading(true);
      const [projectData, next] = await Promise.all([
        client.projects.get(projectId),
        ConlluDocument.load(client, projectId, documentId)
      ]);
      setProject(projectData);
      // Reconcile-on-open: heal UD invariants another app may have broken while
      // this editor was closed (e.g. a sentence split that left a dependency
      // relation crossing a boundary). Only on the INITIAL open (not on every
      // refresh), with edit permission, and BEFORE entering strict mode so the
      // repair's own write doesn't trip OCC. Loud on success AND on failure.
      if (initial && canEditProject(projectData, user)) {
        try {
          const { deletedRelations, error } = await next.reconcileOnOpen();
          if (error) {
            notifyError(
              'Could not auto-repair this document; a dependency relation may cross a sentence boundary. Try reloading.',
              'Repair failed'
            );
          } else if (deletedRelations > 0) {
            notifyWarning(
              `Removed ${deletedRelations} dependency relation${deletedRelations === 1 ? '' : 's'} that ` +
              'crossed a sentence boundary, likely from an edit in another app. Please review.',
              'Document repaired',
              { autoClose: false }
            );
          }
        } catch (e) {
          console.error('Reconcile-on-open failed:', e);
          notifyError('Could not auto-repair this document. Try reloading.', 'Repair failed');
        }
      }
      setDoc(next);
      client.enterStrictMode(documentId);
      setLoadError('');
    } catch (err) {
      if (err.status === 401) {
        window.location.href = '/login';
        return;
      }
      setLoadError('Failed to load document: ' + (err.message || 'Unknown error'));
      console.error('Error fetching data:', err);
    } finally {
      if (initial) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(true);
    // Strict mode is entered in fetchData to OCC-guard annotation edits. It's
    // client-GLOBAL, so it must be exited when we leave this document/editor —
    // otherwise it leaks onto unrelated writes (e.g. tokenizing in the Text
    // Editor), attaching a stale document-version and triggering spurious 409s.
    return () => {
      const client = getClient();
      if (client) client.exitStrictMode();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, documentId]);

  const refreshData = useCallback(() => fetchData(false), [projectId, documentId, getClient]);

  // doc-level operation errors now surface as toasts (see ConlluDocument.setError);
  // only a hard document-load failure stays as a persistent page banner.
  const error = loadError || '';

  // History functionality
  const {
    auditEntries,
    historicalDocument,
    loadingAudit,
    loadingHistorical,
    hasLoadedAudit,
    fetchHistoricalDocument,
    clearHistoricalDocument,
    fetchAuditLog
  } = useDocumentHistory(documentId);

  // When viewing historical state we fall back to the legacy raw-doc render
  // path (useSentenceData still accepts a raw document and delegates to
  // ConlluDocument internally). Handlers are passed `null` in that mode, so
  // mutations stay disabled.
  const activeDocument = viewingHistoricalState ? historicalDocument : doc?.raw;

  // Read-only mode is on when the user lacks write access to the project OR
  // when time-travelling. Key the historical case on `selectedHistoryEntry`, not
  // `viewingHistoricalState`: the entry is set the instant you click (and the
  // banner appears), but `viewingHistoricalState` only flips AFTER the async
  // as-of fetch resolves. Using it would leave a window where the banner says
  // "historical" yet the live current-doc handlers are still wired — letting
  // edits land on the current document (and 409 on save).
  const canEdit = canEditProject(project, user);
  const readOnly = !canEdit || !!selectedHistoryEntry;

  const historicalLayerInfo = useLayerInfo(historicalDocument);
  const layerInfo = viewingHistoricalState ? historicalLayerInfo : doc?.layerInfo;
  const historicalSentences = useSentenceData(historicalDocument);
  const processedSentences = viewingHistoricalState
    ? historicalSentences
    : (doc?.sentences || []);

  useEffect(() => {
    if (loading) return;
    if (!projectId || !project) return;
    if (!user) return;
    if (!activeDocument) return;
    if (!layerInfo || layerInfo.isConfigured) return;

    const missing = layerInfo.missingLayers || [];
    if (missing.length === 0) return;

    const isAdmin = user?.isAdmin || false;
    const isMaintainer = project?.maintainers?.includes(user?.id) || false;

    if (isAdmin || isMaintainer) {
      navigate(`/projects/${projectId}/configuration`, { replace: true });
    }
    // Non-maintainers can't configure/adopt; rather than bouncing them out, the
    // render shows a clear "not set up for UD" notice (see below).
  }, [loading, layerInfo, project, projectId, user, navigate, activeDocument]);

  // Bind annotation/relation handlers to the current document. When viewing
  // historical state we pass `null` so VirtualSentenceRow disables editing.
  // useCallback keeps their identity stable across the transient saving
  // re-renders (isSaving/error emits), so the memoized sentence/cell subtree
  // isn't re-rendered mid-edit — otherwise focus jitters during the save.
  const handleAnnotationUpdate = useCallback((tokenId, field, value) => doc?.updateAnnotation(tokenId, field, value), [doc]);
  const handleFeatureDelete = useCallback((spanId) => doc?.deleteFeature(spanId), [doc]);
  const handleRelationCreate = useCallback((s, t, dep) => doc?.createRelation(s, t, dep), [doc]);
  const handleRelationUpdate = useCallback((id, dep) => doc?.updateRelation(id, dep), [doc]);
  const handleRelationDelete = useCallback((id) => doc?.deleteRelation(id), [doc]);

  // NLP Service integration
  const {
    isParsing,
    isDiscovering,
    hasServices,
    parseStatus,
    discoverServices,
    requestParse,
    clearParseStatus,
    canParse,
  } = useNlpService(projectId, documentId);

  // History drawer handlers
  const handleOpenHistory = () => {
    setIsHistoryDrawerOpen(true);
    // Fetch audit log only when drawer is first opened
    if (!hasLoadedAudit) {
      fetchAuditLog();
    }
  };

  const handleCloseHistory = () => {
    setIsHistoryDrawerOpen(false);
    // Auto-return to current state when closing drawer
    if (selectedHistoryEntry) {
      handleSelectHistoryEntry(null);
    }
  };

  const handleSelectHistoryEntry = async (entry) => {
    if (!entry) {
      // Return to current state
      setSelectedHistoryEntry(null);
      setViewingHistoricalState(false);
      clearHistoricalDocument();
      // The as-of GET poisoned the client's strict-mode document-version tracker
      // with the OLD (historical) version. Refresh it from the live doc so the
      // next edit doesn't fail OCC with a spurious 409.
      const client = getClient();
      if (client) client.documents.get(documentId).catch(() => {});
      return;
    }

    // Set selected entry immediately for instant feedback
    const previousEntry = selectedHistoryEntry;
    setSelectedHistoryEntry(entry);

    // Fetch historical document in background
    const historicalDoc = await fetchHistoricalDocument(entry.time);
    if (historicalDoc) {
      setViewingHistoricalState(true);
    } else {
      // Time travel failed (the hook already toasts). Roll the selection back
      // so the drawer doesn't show a phantom-selected entry whose state never
      // loaded — keep showing whatever we were actually viewing before.
      setSelectedHistoryEntry(previousEntry);
    }
  };

  // Handle parse success - refresh data, toast, and clear status after delay
  useEffect(() => {
    if (parseStatus === 'success') {
      // Refresh document data to show new annotations
      refreshData();
      notifySuccess('Document parsed successfully!');

      // Clear success state after 3 seconds
      const timer = setTimeout(() => {
        clearParseStatus();
      }, 3000);

      return () => clearTimeout(timer);
    }
  }, [parseStatus, refreshData, clearParseStatus]);

  const hasText = !viewingHistoricalState && Boolean(activeDocument?.textLayers?.[0]?.text);

  // Single shared toolbar: History, NLP status, historical-state badge, and a
  // single Auto-Parse / Return-to-Current action group.
  const toolbar = (
    <Group justify="space-between" mt="md">
      <Group gap="sm">
        <Button variant="light" color="gray" leftSection={<IconHistory size={16} />} onClick={handleOpenHistory}>
          History
        </Button>

        <Badge
          size="lg"
          variant="light"
          color={isDiscovering ? 'yellow' : hasServices ? 'green' : 'gray'}
          leftSection={
            isDiscovering ? <Loader size={12} color="yellow" />
              : hasServices ? <IconBolt size={14} />
                : <IconFileOff size={14} />
          }
        >
          {isDiscovering ? 'Checking NLP...' : hasServices ? 'NLP Ready' : 'NLP Offline'}
        </Badge>

        {!isDiscovering && !hasServices && (
          <Button size="xs" onClick={discoverServices}>Retry</Button>
        )}
      </Group>

      <Group gap="sm">
        {selectedHistoryEntry && (
          <Button onClick={handleCloseHistory}>Return to Current</Button>
        )}

        {hasText && canEdit && (
          <Button
            color="green"
            leftSection={<IconBolt size={16} />}
            onClick={requestParse}
            disabled={!canParse || isParsing}
            loading={isParsing}
          >
            Auto Parse
          </Button>
        )}
      </Group>
    </Group>
  );

  // History/parse errors surface as toasts (and the history error also shows
  // inline within the drawer); only the page-load failure is a banner here.
  const errorMessages = error ? (
    <Stack gap="xs" mt="md">
      <Alert color="red">{error}</Alert>
    </Stack>
  ) : null;

  // Persistent read-only banner, shown whenever editing is disabled — either
  // because the user only has viewer access or because they're viewing a past
  // state. The message names the reason so it isn't mysterious. For time travel
  // this is the sole indicator (the toolbar chip was removed), so it carries the
  // timestamp and the loading state too, and shows as soon as an entry is picked.
  const historicalTime = selectedHistoryEntry
    ? new Date(selectedHistoryEntry.time).toLocaleString()
    : null;
  const readOnlyBanner = selectedHistoryEntry ? (
    <Alert
      mt="md"
      py="xs"
      variant="light"
      color="yellow"
      icon={loadingHistorical ? <Loader size={16} color="yellow" /> : <IconInfoCircle size={18} />}
    >
      {loadingHistorical
        ? `Loading the document state as of ${historicalTime}…`
        : `Read-only — viewing the document as of ${historicalTime}. Return to the current state to make changes.`}
    </Alert>
  ) : !canEdit ? (
    <Alert mt="md" py="xs" variant="light" color="blue" icon={<IconInfoCircle size={18} />}>
      Read-only — you have viewer access to this project, so editing is disabled.
    </Alert>
  ) : null;

  // Always render the main container with drawer to maintain state.
  // A project not set up for UD, opened by a non-maintainer: maintainers are
  // redirected to /configuration to set it up/adopt it; everyone else gets a
  // clear notice instead of a broken editor or a silent bounce.
  if (!loading && layerInfo && !layerInfo.isConfigured && !canManageProject(project, user)) {
    return (
      <Box style={{ width: '100%', minHeight: '100vh' }}>
        <Center py={64}>
          <Alert color="yellow" title="Not set up for UD" maw={520} icon={<IconInfoCircle size={18} />}>
            This project hasn’t been set up for Universal Dependencies yet. Ask a project
            maintainer to add UD support.
          </Alert>
        </Center>
      </Box>
    );
  }

  return (
    <Box style={{ width: '100%', minHeight: '100vh' }}>
      <HistoryDrawer
        isOpen={isHistoryDrawerOpen}
        onClose={handleCloseHistory}
        auditEntries={auditEntries}
        loading={loadingAudit}
        onSelectEntry={handleSelectHistoryEntry}
        selectedEntry={selectedHistoryEntry}
        layerInfo={doc?.layerInfo}
      />

      {/* Main content area - pushed right (not overlaid) when the drawer is open */}
      <Box
        style={{
          marginLeft: isHistoryDrawerOpen ? DRAWER_WIDTH : 0,
          transition: 'margin-left 300ms ease',
          minHeight: '100vh',
        }}
      >
        {loading && <Center py={48}><Loader /></Center>}

        {!loading && !activeDocument && (
          <Text ta="center" c="dimmed" py="xl">Document not found</Text>
        )}

        {!loading && activeDocument && (
          <>
            <Box px="lg" py="md">
              <DocumentTabs
                projectId={projectId}
                documentId={documentId}
                project={project}
                document={activeDocument}
              />
              {toolbar}
              {readOnlyBanner}
              {errorMessages}
              {processedSentences.length > 0 && !readOnly && (
                <Text size="xs" c="dimmed" mt="sm">
                  Tip: drag from one token to another to create a dependency relation; click a relation's
                  label to rename it, and double-click a cell to edit an annotation.
                </Text>
              )}
            </Box>

            {processedSentences.length === 0 ? (
              <Text ta="center" c="dimmed" py="xl">
                {viewingHistoricalState
                  ? 'This historical state has no tokenized content to display.'
                  : 'No sentences found. Please ensure the document has been tokenized in the Text Editor.'}
              </Text>
            ) : (
              processedSentences.map((sentenceData, index) => {
                // Calculate total tokens before this sentence
                const totalTokensBefore = processedSentences
                  .slice(0, index)
                  .reduce((total, prevSentence) => total + prevSentence.tokens.length, 0);

                return (
                  <VirtualSentenceRow
                    key={sentenceData.id}
                    sentenceData={sentenceData}
                    onAnnotationUpdate={readOnly ? null : handleAnnotationUpdate}
                    onFeatureDelete={readOnly ? null : handleFeatureDelete}
                    onRelationCreate={readOnly ? null : handleRelationCreate}
                    onRelationUpdate={readOnly ? null : handleRelationUpdate}
                    onRelationDelete={readOnly ? null : handleRelationDelete}
                    sentenceIndex={index}
                    totalTokensBefore={totalTokensBefore}
                    estimatedHeight={250} // Estimated height for placeholder
                    vocab={layerInfo?.vocab}
                    colors={layerInfo?.colors}
                    visibleFields={visibleFields}
                    onToggleField={handleToggleField}
                  />
                );
              })
            )}
          </>
        )}
      </Box>
    </Box>
  );
};
