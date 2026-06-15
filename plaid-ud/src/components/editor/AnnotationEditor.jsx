import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Box, Group, Button, Loader, Text, Center, Alert, Stack, Select, ActionIcon, Popover } from '@mantine/core';
import { IconHistory, IconBolt, IconInfoCircle, IconAdjustments } from '@tabler/icons-react';
import { ServiceSummary } from './ServiceSummary.jsx';
import { ServiceParamForm } from './ServiceParamForm.jsx';
import { VirtualSentenceRow } from './annotation/VirtualSentenceRow.jsx';
import { useLayerInfo } from './hooks/useLayerInfo.js';
import { useSentenceData } from './hooks/useSentenceData.js';
import { useDocumentHistory } from './hooks/useDocumentHistory.js';
import { useNlpService } from './hooks/useNlpService.js';
import { DocumentTabs } from './DocumentTabs.jsx';
import { HistoryDrawer } from './annotation/HistoryDrawer.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { notifications } from '@mantine/notifications';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { useConlluDocument } from '../../domain/useConlluDocument.js';
import { formatFindingsForClipboard } from '../../domain/validate.js';
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

// Surface validateConlluDocument findings: full detail to the console (grouped),
// plus ONE consolidated "Data integrity issue detected" toast with a Copy
// details button. Findings are things we could NOT auto-repair; healed repairs
// get their own "Document repaired" toast separately.
const reportIntegrityFindings = (findings, documentId) => {
  if (!findings?.length) return;
  console.group(`[plaid-ud] Document integrity findings (${findings.length})`);
  findings.forEach(f =>
    (f.severity === 'error' ? console.error : console.warn)(`[${f.code}] ${f.message}`, f.context));
  console.groupEnd();

  const errors = findings.filter(f => f.severity === 'error');
  const headline = errors.length ? errors : findings;
  const reason = headline.length === 1
    ? headline[0].message
    : `${headline.length} issues found — see the browser console for details.`;
  const detail = formatFindingsForClipboard(findings, { documentId });
  notifications.show({
    title: 'Data integrity issue detected',
    color: errors.length ? 'red' : 'yellow',
    autoClose: false,
    message: (
      <Stack gap="xs">
        <Text size="sm">{reason}</Text>
        <Button
          size="xs"
          variant="light"
          w="fit-content"
          onClick={() => navigator.clipboard?.writeText(detail).catch(() => {})}
        >
          Copy details
        </Button>
      </Stack>
    ),
  });
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
  const { getClient, user, logout } = useAuth();
  // Reconcile-on-open is a WRITE (it can seed syntactic-words + delete
  // relations), so it must run at most once per document — otherwise StrictMode's
  // double-invoke of the mount effect would seed duplicates. Track the last
  // document we reconciled; navigation to a new doc re-arms it.
  const reconciledDocRef = useRef(null);

  // Which annotation rows are expanded (document-wide). Persisted to localStorage.
  const [visibleFields, setVisibleFields] = useState(loadVisibleFields);
  useEffect(() => {
    try { localStorage.setItem(FIELD_VISIBILITY_KEY, JSON.stringify(visibleFields)); } catch { /* ignore */ }
  }, [visibleFields]);
  const handleToggleField = useCallback((field) => {
    setVisibleFields((prev) => ({ ...prev, [field]: !prev[field] }));
  }, []);

  useConlluDocument(doc);

  const fetchData = async (initial, doReconcile = initial) => {
    if (!projectId || !documentId) return;
    const client = getClient();
    if (!client) {
      logout();
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
      if (initial && doReconcile && canEditProject(projectData, user)) {
        try {
          const {
            deletedRelations, createdSyntacticWords, deletedOrphans,
            deletedAnnotatedOrphans, dedupedSpans, findings, error,
          } = await next.reconcileOnOpen();
          if (error) {
            notifyError('Could not auto-repair this document. Try reloading.', 'Repair failed');
          } else {
            const parts = [];
            if (createdSyntacticWords > 0) {
              parts.push(`added ${createdSyntacticWords} word${createdSyntacticWords === 1 ? '' : 's'} ` +
                'to the annotation grid');
            }
            if (deletedOrphans > 0) {
              let s = `removed ${deletedOrphans} stray word${deletedOrphans === 1 ? '' : 's'} ` +
                'that no longer matched the text';
              if (deletedAnnotatedOrphans > 0) {
                s += ` (${deletedAnnotatedOrphans} had annotations, recoverable via document history)`;
              }
              parts.push(s);
            }
            if (dedupedSpans > 0) {
              parts.push(`merged ${dedupedSpans} duplicate annotation${dedupedSpans === 1 ? '' : 's'} ` +
                "(values joined with ' | ' — review them)");
            }
            if (deletedRelations > 0) {
              parts.push(`removed ${deletedRelations} dependency relation${deletedRelations === 1 ? '' : 's'} that ` +
                'crossed a sentence boundary');
            }
            if (parts.length) {
              notifyWarning(
                `This document was edited in another app: ${parts.join('; ')}. Please review.`,
                'Document repaired',
                { autoClose: false }
              );
            }
            reportIntegrityFindings(findings, next.id);
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
        logout();
        return;
      }
      setLoadError('Failed to load document: ' + (err.message || 'Unknown error'));
      console.error('Error fetching data:', err);
    } finally {
      if (initial) setLoading(false);
    }
  };

  useEffect(() => {
    // Reconcile once per document. Setting the ref synchronously here (not
    // inside async fetchData) closes the StrictMode race where both effect runs
    // pass the check before either has marked the doc reconciled.
    const doReconcile = reconciledDocRef.current !== documentId;
    if (doReconcile) reconciledDocRef.current = documentId;
    fetchData(true, doReconcile);
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
  const handleConfirmTokens = useCallback((tokenIds) => doc?.confirmTokens(tokenIds), [doc]);

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
    parseServices,
    selectedServiceId,
    setSelectedService,
    selectedService,
    paramSchema,
    paramValues,
    paramErrors,
    setParam,
  } = useNlpService(projectId, documentId, project);

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

  // Single shared toolbar: History on the left; everything NLP lives in one
  // right-hand cluster. There is no separate status badge — when services
  // exist, the selector + Auto Parse button ARE the "ready" signal; the only
  // states needing words are "still discovering" and "nothing online" (with a
  // retry). The cluster only renders when parsing could actually happen
  // (text present, editable, not time-traveling).
  const toolbar = (
    <Group justify="space-between" mt="md">
      <Group gap="sm">
        <Button variant="light" color="gray" leftSection={<IconHistory size={16} />} onClick={handleOpenHistory}>
          History
        </Button>
      </Group>

      <Group gap="sm">
        {selectedHistoryEntry && (
          <Button onClick={handleCloseHistory}>Return to Current</Button>
        )}

        {hasText && canEdit && !selectedHistoryEntry && !hasServices && (
          isDiscovering ? (
            <Group gap={6}>
              <Loader size={14} color="gray" />
              <Text size="sm" c="dimmed">Checking for NLP services…</Text>
            </Group>
          ) : (
            <Group gap="xs">
              <Text size="sm" c="dimmed">No parsing service online</Text>
              <Button size="xs" variant="light" color="gray" onClick={discoverServices}>
                Retry
              </Button>
            </Group>
          )
        )}

        {hasText && canEdit && hasServices && !selectedHistoryEntry && (
          <Group gap="xs">
            <Select
              size="sm"
              w={220}
              data={parseServices.map((s) => ({ value: s.serviceId, label: s.serviceName }))}
              value={selectedServiceId}
              onChange={(v) => v && setSelectedService(v)}
              allowDeselect={false}
              disabled={isParsing}
              aria-label="Parsing service"
            />

            <ServiceSummary service={selectedService} />

            {paramSchema.length > 0 && (
              <Popover width={320} position="bottom-end" withArrow shadow="md">
                <Popover.Target>
                  <ActionIcon variant="light" color="gray" size="lg" aria-label="Service options" disabled={isParsing}>
                    <IconAdjustments size={18} />
                  </ActionIcon>
                </Popover.Target>
                <Popover.Dropdown>
                  <ServiceParamForm
                    schema={paramSchema}
                    values={paramValues}
                    errors={paramErrors}
                    onChange={setParam}
                    disabled={isParsing}
                  />
                </Popover.Dropdown>
              </Popover>
            )}

            <Button
              color="green"
              leftSection={<IconBolt size={16} />}
              onClick={requestParse}
              disabled={!canParse || isParsing}
              loading={isParsing}
            >
              Auto Parse
            </Button>
          </Group>
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
                  label to rename it, and double-click a cell to edit an annotation. Accept a machine
                  prediction without editing with Ctrl+Enter (the word's ✓), or “Accept predictions” for
                  the whole sentence.
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
                    onConfirmTokens={readOnly ? null : handleConfirmTokens}
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
