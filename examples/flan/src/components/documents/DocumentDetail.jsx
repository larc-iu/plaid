import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
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
  Tabs
} from '@mantine/core';
import IconFileText from '@tabler/icons-react/dist/esm/icons/IconFileText.mjs';
import IconEdit from '@tabler/icons-react/dist/esm/icons/IconEdit.mjs';
import IconAnalyze from '@tabler/icons-react/dist/esm/icons/IconAnalyze.mjs';
import IconArrowLeft from '@tabler/icons-react/dist/esm/icons/IconArrowLeft.mjs';
import IconLetterA from '@tabler/icons-react/dist/esm/icons/IconLetterA.mjs';
import IconPlayerPlay from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import { DocumentMetadata } from './DocumentMetadata';
import { DocumentBaseline } from './DocumentBaseline';
import { DocumentTokenize } from './DocumentTokenize';
import { DocumentAnalyze } from './DocumentAnalyze';
import { DocumentMedia } from './DocumentMedia';
import { parseDocument, validateParsedDocument } from '../../utils/documentParser';

export const DocumentDetail = () => {
  const { projectId, documentId } = useParams();
  const navigate = useNavigate();
  const { user, client } = useAuth();
  const [document, setDocument] = useState(null);
  const [project, setProject] = useState(null);
  const [parsedDocument, setParsedDocument] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('metadata');

  // Function to refresh document data
  const refreshDocumentData = useCallback(async () => {
    try {
      const [documentData, projectData] = await Promise.all([
        client.documents.get(documentId, true),
        client.projects.get(projectId)
      ]);

      const parsed = parseDocument(documentData);
      setParsedDocument(parsed);
      setDocument(documentData);
      setProject(projectData);
    } catch (error) {
      console.error('Error refreshing document data:', error);
    }
  }, [client, documentId, projectId]);

  // Function to update a specific path in the parsed document
  const setParsedDocumentKey = useCallback((path, updater) => {
    setParsedDocument(prevDoc => {
      if (!prevDoc) return prevDoc;
      
      // We need to clone only the objects along the path we're changing
      const newDoc = { ...prevDoc };
      let current = newDoc;
      let parent = null;
      
      // Navigate to the parent of the target
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        parent = current;
        // Only clone the objects/arrays along the path we're modifying
        current[key] = Array.isArray(current[key]) 
          ? [...current[key]] 
          : { ...current[key] };
        current = current[key];
      }
      
      // Update the target value
      const lastKey = path[path.length - 1];
      const currentValue = current[lastKey];
      current[lastKey] = typeof updater === 'function' 
        ? updater(currentValue) 
        : updater;
      
      return newDoc;
    });
  }, []);

  // Fetch document and project data
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        
        console.log('DocumentDetail: Starting fetch with:', { projectId, documentId, hasClient: !!client });
        
        if (!client) {
          console.log('DocumentDetail: No client, throwing auth error');
          throw new Error('Not authenticated');
        }

        // Fetch document and project data
        console.log('DocumentDetail: Making API calls...');
        const [documentData, projectData] = await Promise.all([
          client.documents.get(documentId, true),
          client.projects.get(projectId)
        ]);

        console.log('DocumentDetail: API calls successful:', { documentData, projectData });
        
        // Parse the document data into a render-friendly structure
        try {
          const parsed = parseDocument(documentData);
          console.log('DocumentDetail: Document parsed successfully:', parsed);
          
          // Validate the parsed structure
          if (!validateParsedDocument(parsed)) {
            console.warn('DocumentDetail: Parsed document validation failed');
          }
          
          setParsedDocument(parsed);
        } catch (parseError) {
          console.error('DocumentDetail: Document parsing failed:', parseError);
          setError(`Failed to parse document: ${parseError.message}`);
        }
        
        setDocument(documentData);
        setProject(projectData);
        setError('');
      } catch (err) {
        console.error('DocumentDetail: Error occurred:', err);
        if (err.message === 'Not authenticated' || err.status === 401) {
          console.log('DocumentDetail: Redirecting to login due to auth error');
          navigate('/login');
          return;
        }
        setError('Failed to load document');
        console.error('Error fetching document:', err);
      } finally {
        setLoading(false);
      }
    };

    console.log('DocumentDetail: useEffect triggered with:', { projectId, documentId, hasClient: !!client });
    if (projectId && documentId) {
      fetchData();
    }
  }, [projectId, documentId, client, navigate]);

  const breadcrumbItems = [
    { title: 'Projects', href: '/projects' },
    { title: project?.name || 'Loading...', href: `/projects/${projectId}` },
    { title: document?.name || 'Loading...', href: null }
  ].map((item, index) => (
    item.href ? (
      <Anchor key={index} component={Link} to={item.href}>
        {item.title}
      </Anchor>
    ) : (
      <Text key={index}>{item.title}</Text>
    )
  ));

  if (loading) {
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

  if (error) {
    return (
      <Container size="lg" py="xl">
        <Alert color="red" title="Error">
          {error}
        </Alert>
      </Container>
    );
  }

  if (!document) {
    return (
      <Container size="lg" py="xl">
        <Alert color="red" title="Document Not Found">
          The requested document could not be found.
        </Alert>
      </Container>
    );
  }

  return (
    <Container size="lg" py="xl">
      <Stack spacing="lg">
        <Breadcrumbs>
          {breadcrumbItems}
        </Breadcrumbs>

        <div>
          <Title order={1} mb="xs">{document.name}</Title>
          <Text c="dimmed" size="xs" mb="lg">{document.id}</Text>
        </div>

        <Tabs value={activeTab} onChange={async (newTab) => {
          setTabLoading(true);
          await refreshDocumentData();
          setActiveTab(newTab);
          setTabLoading(false);
        }}>
          <Tabs.List>
            <Tabs.Tab value="metadata" leftSection={<IconFileText size={16} />}>
              Metadata
            </Tabs.Tab>
            <Tabs.Tab value="media" leftSection={<IconPlayerPlay size={16} />}>
              Media
            </Tabs.Tab>
            <Tabs.Tab value="baseline" leftSection={<IconEdit size={16} />}>
              Baseline
            </Tabs.Tab>
            <Tabs.Tab value="tokenize" leftSection={<IconLetterA size={16} />} disabled={parsedDocument?.layers?.primaryTextLayer?.text?.body.length === 0}>
              Tokenize
            </Tabs.Tab>
            <Tabs.Tab value="analyze" leftSection={<IconAnalyze size={16} />} disabled={!parsedDocument?.sentences?.some(s => s.tokens?.length > 0)}>
              Analyze
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="metadata">
            {tabLoading ? (
              <Center py="xl">
                <Loader size="lg" />
              </Center>
            ) : (
              activeTab === "metadata" && <DocumentMetadata
                document={document}
                parsedDocument={parsedDocument}
                project={project}
                client={client}
                onDocumentUpdated={setDocument}
              />
            )}
          </Tabs.Panel>

          <Tabs.Panel value="baseline">
            {tabLoading ? (
              <Center py="xl">
                <Loader size="lg" />
              </Center>
            ) : (
              activeTab === "baseline" && <DocumentBaseline
                document={document}
                parsedDocument={parsedDocument}
                project={project}
                client={client}
                onTextUpdated={refreshDocumentData}
              />
            )}
          </Tabs.Panel>

          <Tabs.Panel value="tokenize">
            {tabLoading ? (
              <Center py="xl">
                <Loader size="lg" />
              </Center>
            ) : (
              activeTab === "tokenize" && <DocumentTokenize
                document={document}
                parsedDocument={parsedDocument}
                project={project}
                client={client}
                onTokenizationComplete={refreshDocumentData}
              />
            )}
          </Tabs.Panel>

          <Tabs.Panel value="analyze">
            {tabLoading ? (
              <Center py="xl">
                <Loader size="lg" />
              </Center>
            ) : (
              activeTab === "analyze" && <DocumentAnalyze
                document={document}
                parsedDocument={parsedDocument}
                project={project}
                client={client}
                setParsedDocumentKey={setParsedDocumentKey}
              />
            )}
          </Tabs.Panel>

          <Tabs.Panel value="media">
            {tabLoading ? (
              <Center py="xl">
                <Loader size="lg" />
              </Center>
            ) : (
              activeTab === "media" && <DocumentMedia
                document={document}
                parsedDocument={parsedDocument}
                project={project}
                client={client}
                onMediaUpdated={refreshDocumentData}
              />
            )}
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Container>
  );
};