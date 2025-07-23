import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { StrictModeProvider } from '../../contexts/StrictModeContext';
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
  const [vocabularies, setVocabularies] = useState({});
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

      // Fetch vocabularies associated with this project
      let projectVocabularies = {};
      try {
        // Get vocabulary IDs from project.vocabs
        const projectVocabIds = projectData.vocabs?.map(vocab => vocab.id) || [];
        
        if (projectVocabIds.length > 0) {
          // Fetch full vocabulary data including items for project-associated vocabs only
          const vocabulariesWithItems = await Promise.all(
            projectVocabIds.map(async (vocabId) => {
              try {
                const fullVocab = await client.vocabLayers.get(vocabId, true);
                return fullVocab;
              } catch (error) {
                console.warn(`Error fetching full vocab data for ${vocabId}:`, error);
                return null;
              }
            })
          );
          
          // Convert array to object with ID as key, filtering out null values
          projectVocabularies = vocabulariesWithItems
            .filter(vocab => vocab !== null)
            .reduce((acc, vocab) => {
              acc[vocab.id] = vocab;
              return acc;
            }, {});
        }
      } catch (vocabError) {
        console.warn('Error fetching vocabularies:', vocabError);
        // Continue with empty vocabularies if fetch fails
      }

      const parsed = parseDocument(documentData, client);
      setParsedDocument(parsed);
      setDocument(documentData);
      setProject(projectData);
      setVocabularies(projectVocabularies);
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

        // Fetch vocabularies associated with this project
        let projectVocabularies = {};
        try {
          console.log('DocumentDetail: Fetching project-associated vocabularies...');
          
          // Get vocabulary IDs from project.vocabs
          const projectVocabIds = projectData.vocabs?.map(vocab => vocab.id) || [];
          console.log('DocumentDetail: Project vocab IDs:', projectVocabIds);
          
          if (projectVocabIds.length > 0) {
            // Fetch full vocabulary data including items for project-associated vocabs only
            const vocabulariesWithItems = await Promise.all(
              projectVocabIds.map(async (vocabId) => {
                try {
                  const fullVocab = await client.vocabLayers.get(vocabId, true);
                  return fullVocab;
                } catch (error) {
                  console.warn(`Error fetching full vocab data for ${vocabId}:`, error);
                  return null;
                }
              })
            );
            
            // Convert array to object with ID as key, filtering out null values
            projectVocabularies = vocabulariesWithItems
              .filter(vocab => vocab !== null)
              .reduce((acc, vocab) => {
                acc[vocab.id] = vocab;
                return acc;
              }, {});
            
            console.log('DocumentDetail: Project vocabularies loaded:', Object.keys(projectVocabularies).length, 'with items:', vocabulariesWithItems.filter(v => v).map(v => `${v.name}: ${v.items?.length || 0} items`));
          } else {
            console.log('DocumentDetail: No vocabularies associated with this project');
          }
        } catch (vocabError) {
          console.warn('DocumentDetail: Error fetching vocabularies:', vocabError);
          // Continue with empty vocabularies if fetch fails
        }
        
        // Parse the document data into a render-friendly structure
        try {
          const parsed = parseDocument(documentData, client);
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
        setVocabularies(projectVocabularies);
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
    <StrictModeProvider documentId={documentId}>
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
                  vocabularies={vocabularies}
                  setParsedDocumentKey={setParsedDocumentKey}
                  onDocumentReload={refreshDocumentData}
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
                  onMediaUpdated={refreshDocumentData}
                />
              )}
            </Tabs.Panel>
          </Tabs>
        </Stack>
      </Container>
    </StrictModeProvider>
  );
};