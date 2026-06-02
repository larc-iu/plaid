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
import { notifySuccess } from '../../utils/feedback.jsx';

const DRAWER_WIDTH = 384;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, documentId]);

  const refreshData = useCallback(() => fetchData(false), [projectId, documentId, getClient]);

  const error = loadError || doc?.error || '';

  // History functionality
  const {
    auditEntries,
    historicalDocument,
    loadingAudit,
    loadingHistorical,
    error: historyError,
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
    } else {
      navigate('/projects', { replace: true });
    }
  }, [loading, layerInfo, project, projectId, user, navigate, activeDocument]);

  // Bind annotation/relation handlers to the current document. When viewing
  // historical state we pass `null` so VirtualSentenceRow disables editing.
  const handleAnnotationUpdate = (tokenId, field, value) => doc?.updateAnnotation(tokenId, field, value);
  const handleFeatureDelete = (spanId) => doc?.deleteFeature(spanId);
  const handleRelationCreate = (s, t, dep) => doc?.createRelation(s, t, dep);
  const handleRelationUpdate = (id, dep) => doc?.updateRelation(id, dep);
  const handleRelationDelete = (id) => doc?.deleteRelation(id);

  // NLP Service integration
  const {
    isParsing,
    isDiscovering,
    hasServices,
    parseStatus,
    parseError,
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
      return;
    }

    // Set selected entry immediately for instant feedback
    setSelectedHistoryEntry(entry);

    // Fetch historical document in background
    const historicalDoc = await fetchHistoricalDocument(entry.time);
    if (historicalDoc) {
      setViewingHistoricalState(true);
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

        {selectedHistoryEntry && (
          <Badge
            size="lg"
            variant="light"
            color="yellow"
            leftSection={loadingHistorical ? <Loader size={12} color="yellow" /> : <IconInfoCircle size={14} />}
          >
            {loadingHistorical
              ? 'Loading Historical State...'
              : `Viewing Historical State — ${new Date(selectedHistoryEntry.time).toLocaleString()}`}
          </Badge>
        )}
      </Group>

      <Group gap="sm">
        {viewingHistoricalState && (
          <Button onClick={() => handleSelectHistoryEntry(null)}>Return to Current</Button>
        )}

        {hasText && (
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

  const errorMessages = (error || historyError || parseError) ? (
    <Stack gap="xs" mt="md">
      {error && <Alert color="red">{error}</Alert>}
      {historyError && <Alert color="red">{historyError}</Alert>}
      {parseError && <Alert color="red">Parse Error: {parseError}</Alert>}
    </Stack>
  ) : null;

  // Always render the main container with drawer to maintain state.
  return (
    <Box style={{ width: '100%', minHeight: '100vh' }}>
      <HistoryDrawer
        isOpen={isHistoryDrawerOpen}
        onClose={handleCloseHistory}
        auditEntries={auditEntries}
        loading={loadingAudit}
        error={historyError}
        onSelectEntry={handleSelectHistoryEntry}
        selectedEntry={selectedHistoryEntry}
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
              {errorMessages}
              {processedSentences.length > 0 && !viewingHistoricalState && (
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
                    onAnnotationUpdate={viewingHistoricalState ? null : handleAnnotationUpdate}
                    onFeatureDelete={viewingHistoricalState ? null : handleFeatureDelete}
                    onRelationCreate={viewingHistoricalState ? null : handleRelationCreate}
                    onRelationUpdate={viewingHistoricalState ? null : handleRelationUpdate}
                    onRelationDelete={viewingHistoricalState ? null : handleRelationDelete}
                    sentenceIndex={index}
                    totalTokensBefore={totalTokensBefore}
                    estimatedHeight={250} // Estimated height for placeholder
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
