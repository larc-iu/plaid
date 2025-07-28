import { useEffect, useCallback, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useSnapshot } from 'valtio';
import { useAuth } from '../../contexts/AuthContext';
import { useStrictClient } from './contexts/StrictModeContext.jsx';
import documentsStore, { loadDocument, loadHistoricalDocument, loadAuditLog } from '../../stores/documentsStore';
import {
  Container, 
  Title, 
  Text, 
  Stack,
  Alert,
  Loader,
  Center,
  Breadcrumbs,
  Anchor,
  Box,
  Tabs,
  ActionIcon,
  Group
} from '@mantine/core';
import IconHistory from '@tabler/icons-react/dist/esm/icons/IconHistory.mjs';
import IconFileText from '@tabler/icons-react/dist/esm/icons/IconFileText.mjs';
import IconPlayerPlay from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import IconLetterA from '@tabler/icons-react/dist/esm/icons/IconLetterA.mjs';
import IconMicrophone from '@tabler/icons-react/dist/esm/icons/IconMicrophone.mjs';
import IconTable from '@tabler/icons-react/dist/esm/icons/IconTable.mjs';
import { DocumentTokenize } from './tokenize/DocumentTokenize.jsx';
import { HistoryDrawer } from './HistoryDrawer.jsx';
import { DocumentMetadata } from './metadata/DocumentMetadata.jsx';
import { DocumentBaseline } from './baseline/DocumentBaseline.jsx';
import { DocumentMedia } from './media/DocumentMedia.jsx';
import { DocumentAnalyze } from './analyze/DocumentAnalyze.jsx';
import { useDocumentPermissions } from './hooks/useDocumentPermissions.js';

export const DocumentDetail = () => {
  const { projectId, documentId } = useParams();
  const navigate = useNavigate();
  const client = useStrictClient();

  const docProxy = documentsStore?.[projectId]?.[documentId];
  const storeSnap = useSnapshot(documentsStore);
  const permissions = useDocumentPermissions(projectId);

  const refreshDocumentData = useCallback(async () => {
    try {
      await loadDocument(projectId, documentId, client);
    } catch (error) {
      console.error('Error refreshing document data:', error);
      const docState = documentsStore[projectId][documentId];
      docState.ui.error = error.message || 'Failed to refresh document';
    }
  }, [client, documentId, projectId]);

  // History drawer handlers
  const handleOpenHistory = useCallback(() => {
    const docState = documentsStore[projectId][documentId];
    docState.ui.history.open = true;
    if (!docState.ui.history.hasLoadedAudit) {
      loadAuditLog(projectId, documentId, client);
    }
  }, [projectId, documentId, client]);

  const handleCloseHistory = useCallback(() => {
    const docState = documentsStore[projectId][documentId];
    docState.ui.history.open = false;
    if (docState.ui.history.selectedEntry) {
      handleSelectHistoryEntry(null);
    }
  }, [projectId, documentId]);

  const handleSelectHistoryEntry = useCallback(async (entry) => {
    const docState = documentsStore[projectId][documentId];
    if (!entry) {
      docState.ui.history.selectedEntry = null;
      docState.ui.history.viewingHistorical = false;
      await refreshDocumentData();
      return;
    }

    docState.ui.history.selectedEntry = entry;
    try {
      await loadHistoricalDocument(projectId, documentId, entry.time, client);
    } catch (error) {
      console.error('Error loading historical document:', error);
      docState.ui.history.auditError = 'Failed to load historical document';
    }
  }, [projectId, documentId, client, refreshDocumentData]);

  useEffect(() => {
    async function fetchData() {
      if (!client) {
        navigate('/login');
        return;
      }

      try {
        await refreshDocumentData();
      } catch (err) {
        if (err.message === 'Not authenticated' || err.status === 401) {
          navigate('/login');
          return;
        }
        docProxy.ui.error = 'Failed to load document';
      }
    }
    fetchData();
  }, [documentId]);

  if (!docProxy || !storeSnap[projectId][documentId].layers) {
    return (
        <Container size="lg" py="xl">
          <Center>
            <Stack align="center" spacing="md">
              <Loader size="lg" />
              <Text>Loading document...</Text>
            </Stack>
          </Center>
        </Container>
    );
  }

  const docSnap = storeSnap[projectId][documentId];

  // Calculate unified read-only state
  const isViewingHistorical = docSnap?.ui?.history?.viewingHistorical || false;
  const readOnly = permissions.isReadOnly || isViewingHistorical;

  const breadcrumbItems = [
    { title: 'Projects', href: '/projects' },
    { title: docSnap?.project?.name || 'Loading...', href: `/projects/${projectId}` },
    { title: docSnap?.document?.name || 'Loading...', href: null }
  ].map((item, index) => (
    item.href ? (
      <Anchor key={index} component={Link} to={item.href}>
        {item.title}
      </Anchor>
    ) : (
      <Text key={index}>{item.title}</Text>
    )
  ));

  if (docSnap.ui.error) {
    return (
      <Container size="lg" py="xl">
        <Alert color="red" title="Error">
          {docSnap.ui.error}
        </Alert>
      </Container>
    );
  }

  return (
      <>
        {/* History Drawer */}
        <HistoryDrawer
          isOpen={docSnap.ui.history.open}
          onClose={handleCloseHistory}
          auditEntries={docSnap.ui.history.auditEntries}
          loading={docSnap.ui.history.loadingAudit}
          error={docSnap.ui.history.auditError}
          onSelectEntry={handleSelectHistoryEntry}
          selectedEntry={docSnap.ui.history.selectedEntry}
        />
        
        {/* History Tab Trigger */}
        {!docSnap.ui.history.open && (
          <Box
            style={{
              position: 'fixed',
              left: 0,
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 1000,
              width: '6px',
              height: '120px',
              backgroundColor: '#868e96',
              borderTopRightRadius: '6px',
              borderBottomRightRadius: '6px',
              cursor: 'pointer',
              transition: 'width 200ms ease, background-color 200ms ease',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.width = '40px';
              e.currentTarget.style.backgroundColor = '#495057';
              const icon = e.currentTarget.querySelector('svg');
              if (icon) icon.style.opacity = '1';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.width = '6px';
              e.currentTarget.style.backgroundColor = '#868e96';
              const icon = e.currentTarget.querySelector('svg');
              if (icon) icon.style.opacity = '0';
            }}
            onClick={handleOpenHistory}
          >
            <IconHistory size={16} style={{ 
              opacity: 0,
              transition: 'opacity 200ms ease',
              color: 'white',
              minWidth: '16px'
            }} />
          </Box>
        )}
        
        <Box
            style={{
              marginLeft: docSnap.ui.history.open ? '400px' : '0',
              transition: 'margin-left 200ms ease',
              minHeight: '100vh'
            }}
        >
          <Container size="lg" py="xl">
              <Stack spacing="lg">
                <Breadcrumbs>
                  {breadcrumbItems}
                </Breadcrumbs>

                <div>
                  <Title order={1} mb="xs">{docSnap.document.name}</Title>
                  <Text c="dimmed" size="xs" mb="lg">{docSnap.document.id}</Text>
                  {docSnap.ui.history.viewingHistorical && (
                      <Alert color="blue" mb="lg">
                        <Text size="sm" fw={500}>Viewing Historical State</Text>
                        <Text size="xs">Changes cannot be made while viewing historical data</Text>
                      </Alert>
                  )}
                </div>

                <Tabs
                    value={docSnap.ui.activeTab}
                    onChange={async (newTab) => {
                      docProxy.ui.activeTab = newTab;
                      await refreshDocumentData();
                    }}
                >
                  <Tabs.List>
                    <Tabs.Tab value="metadata" leftSection={<IconFileText size={16} />}>
                      Metadata
                    </Tabs.Tab>
                    <Tabs.Tab value="baseline" leftSection={<IconLetterA size={16} />}>
                      Baseline
                    </Tabs.Tab>
                    <Tabs.Tab value="media" leftSection={<IconMicrophone size={16} />}>
                      Media
                    </Tabs.Tab>
                    <Tabs.Tab value="tokenize" leftSection={<IconPlayerPlay size={16} />}>
                      Tokenize
                    </Tabs.Tab>
                    <Tabs.Tab value="analyze" leftSection={<IconTable size={16} />}>
                      Analyze
                    </Tabs.Tab>
                  </Tabs.List>

                  <Tabs.Panel value="metadata">
                    {docSnap.ui.loading ? (
                        <Center py="xl">
                          <Loader size="lg" />
                        </Center>
                    ) : (
                        docSnap.ui.activeTab === "metadata" && <DocumentMetadata
                            projectId={projectId}
                            documentId={documentId}
                            reload={refreshDocumentData}
                            client={client}
                            readOnly={readOnly}
                        />
                    )}
                  </Tabs.Panel>

                  <Tabs.Panel value="baseline">
                    {docSnap.ui.loading ? (
                        <Center py="xl">
                          <Loader size="lg" />
                        </Center>
                    ) : (
                        docSnap.ui.activeTab === "baseline" && <DocumentBaseline
                            projectId={projectId}
                            documentId={documentId}
                            reload={refreshDocumentData}
                            client={client}
                            readOnly={readOnly}
                        />
                    )}
                  </Tabs.Panel>

                  <Tabs.Panel value="media">
                    {docSnap.ui.loading ? (
                        <Center py="xl">
                          <Loader size="lg" />
                        </Center>
                    ) : (
                        docSnap.ui.activeTab === "media" && <DocumentMedia
                            projectId={projectId}
                            documentId={documentId}
                            reload={refreshDocumentData}
                            client={client}
                            readOnly={readOnly}
                        />
                    )}
                  </Tabs.Panel>

                  <Tabs.Panel value="tokenize">
                    {docSnap.ui.loading ? (
                        <Center py="xl">
                          <Loader size="lg" />
                        </Center>
                    ) : (
                        docSnap.ui.activeTab === "tokenize" && <DocumentTokenize
                            documentId={documentId}
                            projectId={projectId}
                            reload={refreshDocumentData}
                            client={client}
                            readOnly={readOnly}
                        />
                    )}
                  </Tabs.Panel>

                  <Tabs.Panel value="analyze">
                    {docSnap.ui.loading ? (
                        <Center py="xl">
                          <Loader size="lg" />
                        </Center>
                    ) : (
                        docSnap.ui.activeTab === "analyze" && <DocumentAnalyze
                            projectId={projectId}
                            documentId={documentId}
                            reload={refreshDocumentData}
                            client={client}
                            readOnly={readOnly}
                        />
                    )}
                  </Tabs.Panel>
                </Tabs>
              </Stack>
            </Container>
        </Box>
      </>
  );
};