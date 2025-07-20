import { useState, useEffect } from 'react';
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
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('metadata');

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

        <Tabs value={activeTab} onChange={setActiveTab}>
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
            {activeTab === 'metadata' && (
              <DocumentMetadata 
                document={document}
                parsedDocument={parsedDocument}
                project={project}
                client={client}
                onDocumentUpdated={setDocument}
              />
            )}
          </Tabs.Panel>

          <Tabs.Panel value="baseline">
            {activeTab === 'baseline' && (
              <DocumentBaseline 
                document={document}
                parsedDocument={parsedDocument}
                project={project}
                client={client}
                onTextUpdated={() => {
                  // Refresh the document data after text update
                  const fetchData = async () => {
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
                      console.error('Error refreshing document after text update:', error);
                    }
                  };
                  fetchData();
                }}
              />
            )}
          </Tabs.Panel>

          <Tabs.Panel value="tokenize">
            {activeTab === 'tokenize' && (
              <DocumentTokenize 
                document={document}
                parsedDocument={parsedDocument}
                project={project}
                client={client}
                onTokenizationComplete={() => {
                  // Refresh the document data after tokenization
                  const fetchData = async () => {
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
                      console.error('Error refreshing document after tokenization:', error);
                    }
                  };
                  fetchData();
                }}
              />
            )}
          </Tabs.Panel>

          <Tabs.Panel value="analyze">
            {activeTab === 'analyze' && (
              <DocumentAnalyze 
                document={document}
                parsedDocument={parsedDocument}
                project={project}
                client={client}
              />
            )}
          </Tabs.Panel>

          <Tabs.Panel value="media">
            {activeTab === 'media' && (
              <DocumentMedia 
                document={document}
                parsedDocument={parsedDocument}
                project={project}
                client={client}
                onMediaUpdated={() => {
                  // Refresh the document data after media operations
                  const fetchData = async () => {
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
                      console.error('Error refreshing document after media operation:', error);
                    }
                  };
                  fetchData();
                }}
              />
            )}
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Container>
  );
};