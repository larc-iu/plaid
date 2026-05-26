import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Stack, 
  Text, 
  Paper, 
  Button, 
  Progress, 
  Alert, 
  Group,
  List,
  Badge,
  Divider,
  Loader,
  Title
} from '@mantine/core';
import IconCheck from '@tabler/icons-react/dist/esm/icons/IconCheck.mjs';
import IconX from '@tabler/icons-react/dist/esm/icons/IconX.mjs';
import IconRefresh from '@tabler/icons-react/dist/esm/icons/IconRefresh.mjs';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconPlayerPlay from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import { notifications } from '@mantine/notifications';

export const ConfirmationStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, client }) => {
  const navigate = useNavigate();
  const [isExecuting, setIsExecuting] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [currentOperation, setCurrentOperation] = useState('');
  const [progress, setProgress] = useState(0);
  const [errors, setErrors] = useState([]);
  const [createdResources, setCreatedResources] = useState({});
  // Tracks the project id created during a NEW-project flow that may have
  // partially failed. On retry, we resume against this id instead of creating
  // another project. Reset only on component unmount/remount (fresh wizard).
  const [createdProjectId, setCreatedProjectId] = useState(null);

  // Helper function to update progress
  const updateProgress = (percent, operation) => {
    setProgress(percent);
    setCurrentOperation(operation);
  };

  // Execute setup function
  const executeSetup = async () => {
    setIsExecuting(true);
    setErrors([]);
    setProgress(0);
    setCreatedResources({});
    
    try {
      if (!client) {
        throw new Error('Authentication required');
      }

      // Determine the project id we're operating against. If a previous attempt
      // in this wizard session already created the project (NEW flow that failed
      // partway), resume against that id rather than creating a duplicate.
      const resumeProjectId = isNewProject ? createdProjectId : projectId;

      // Refuse to re-run setup on an already-initialized project.
      // Re-running would create a second set of plaid-tagged layers and break
      // findPrimaryLayers (which returns the first match). Token-layer overlap
      // modes and parent-token-layer ids are immutable, so we cannot adopt the
      // existing layers either — user must create a new project instead.
      // This guard applies to existing-project flows AND to new-project retries
      // (the just-created project won't be initialized, so it falls through).
      if (resumeProjectId) {
        try {
          const existingProject = await client.projects.get(resumeProjectId);
          if (existingProject?.config?.plaid?.initialized === true) {
            notifications.show({
              title: 'Project Already Initialized',
              message: 'This project is already initialized with Plaid Base. Re-running setup is not supported — create a new project instead.',
              color: 'red'
            });
            setIsExecuting(false);
            return;
          }
        } catch (checkError) {
          console.warn('Could not check project initialization status:', checkError);
          // Fall through — if we can't check, attempt setup and let it surface other errors.
        }
      }

      let currentProjectId = resumeProjectId || projectId;
      const resources = {};

      // Step 1: Create project if new project (skip if we already created one
      // in a prior attempt — see createdProjectId).
      if (isNewProject && !createdProjectId && setupData.basicInfo?.projectName) {
        updateProgress(10, 'Creating new project...');
        const newProject = await client.projects.create(setupData.basicInfo.projectName);
        currentProjectId = newProject.id;
        resources.project = newProject;
        // Persist immediately so a subsequent failure + retry won't recreate.
        setCreatedProjectId(newProject.id);
      }

      // Step 2: Create/configure text layer
      let textLayerId = null;
      if (isNewProject) {
        // For new projects, always create a default text layer
        updateProgress(20, 'Creating text layer...');
        const textLayer = await client.textLayers.create(currentProjectId, 'Main Text');
        textLayerId = textLayer.id;
        resources.textLayer = textLayer;
        // Mark as plaid-managed
        await client.textLayers.setConfig(textLayerId, "plaid", "primary", true);
      } else if (setupData.layerSelection?.textLayerType === 'new' && setupData.layerSelection?.newTextLayerName) {
        updateProgress(20, 'Creating text layer...');
        const textLayer = await client.textLayers.create(currentProjectId, setupData.layerSelection.newTextLayerName);
        textLayerId = textLayer.id;
        resources.textLayer = textLayer;
        // Mark as plaid-managed
        await client.textLayers.setConfig(textLayerId, "plaid", "primary", true);
      } else if (setupData.layerSelection?.textLayerType === 'existing' && setupData.layerSelection?.selectedTextLayerId) {
        textLayerId = setupData.layerSelection.selectedTextLayerId;
        updateProgress(20, 'Using existing text layer...');
        // Mark as plaid-managed
        await client.textLayers.setConfig(textLayerId, "plaid", "primary", true);
      }

      // Token layers are created in hierarchy order: sentence → word → morpheme.
      // Sentence is a :partitioning root layer covering the entire text.
      // Word is :non-overlapping, nested under sentence (server enforces words don't cross sentence boundaries).
      // Morpheme is :any, nested under word (server cascades word delete → morpheme delete).
      // Alignment is a separate :non-overlapping root layer (time-aligned, independent of text hierarchy).
      let sentenceTokenLayerId = null;
      let tokenLayerId = null;
      let morphemeLayerId = null;
      let alignmentTokenLayerId = null;

      if (textLayerId) {
        // Step 3: Create sentence token layer (partitioning root)
        updateProgress(28, 'Creating sentence layer...');
        const sentenceTokenLayer = await client.tokenLayers.create(textLayerId, 'Sentences', 'partitioning');
        sentenceTokenLayerId = sentenceTokenLayer.id;
        resources.sentenceTokenLayer = sentenceTokenLayer;
        await client.tokenLayers.setConfig(sentenceTokenLayerId, "plaid", "sentence", true);

        // Step 4: Create word/primary token layer (non-overlapping, nested in sentence)
        const tokenLayerName = (!isNewProject && setupData.layerSelection?.newTokenLayerName)
          ? setupData.layerSelection.newTokenLayerName
          : 'Main Tokens';
        updateProgress(32, 'Creating token layer...');
        const tokenLayer = await client.tokenLayers.create(textLayerId, tokenLayerName, 'non-overlapping', sentenceTokenLayerId);
        tokenLayerId = tokenLayer.id;
        resources.tokenLayer = tokenLayer;
        await client.tokenLayers.setConfig(tokenLayerId, "plaid", "primary", true);

        // Step 5: Create morpheme token layer (any, nested in word)
        const morphemeLayerName = (!isNewProject && setupData.layerSelection?.newMorphemeLayerName)
          ? setupData.layerSelection.newMorphemeLayerName
          : 'Main Morphemes';
        updateProgress(35, 'Creating morpheme layer...');
        const morphemeLayer = await client.tokenLayers.create(textLayerId, morphemeLayerName, 'any', tokenLayerId);
        morphemeLayerId = morphemeLayer.id;
        resources.morphemeLayer = morphemeLayer;
        await client.tokenLayers.setConfig(morphemeLayerId, "plaid", "morpheme", true);

        // Step 6: Create alignment token layer (non-overlapping, root, time-aligned)
        updateProgress(38, 'Creating alignment token layer...');
        const alignmentTokenLayer = await client.tokenLayers.create(textLayerId, 'Time Alignment', 'non-overlapping');
        alignmentTokenLayerId = alignmentTokenLayer.id;
        resources.alignmentTokenLayer = alignmentTokenLayer;
        await client.tokenLayers.setConfig(alignmentTokenLayerId, "plaid", "alignment", true);
      }

      // Step 5: Configure orthographies on token layer
      if (tokenLayerId && setupData.orthographies?.orthographies) {
        updateProgress(40, 'Configuring orthographies...');
        const orthographiesConfig = setupData.orthographies.orthographies
          .filter(orth => !orth.isBaseline) // Skip baseline orthography
          .map(orth => ({
            name: orth.name
          }));
        
        // Always save the config to indicate user choice, even if empty
        await client.tokenLayers.setConfig(tokenLayerId, "plaid", "orthographies", orthographiesConfig);
      }

      // Step 6: Create span layers for annotation fields
      if (tokenLayerId && sentenceTokenLayerId) {
        updateProgress(50, 'Creating annotation field layers...');
        const createdSpanLayers = [];
        
        // Create span layers for user-defined annotation fields
        if (setupData.fields?.fields?.length > 0) {
          for (const field of setupData.fields.fields) {
            try {
              // Choose parent layer based on field scope
              let parentLayerId;
              let parentType;
              
              if (field.scope === 'Sentence') {
                parentLayerId = sentenceTokenLayerId;
                parentType = 'sentence token layer';
              } else if (field.scope === 'Morpheme' && morphemeLayerId) {
                parentLayerId = morphemeLayerId;
                parentType = 'morpheme token layer';
              } else {
                // Default to token layer for 'Word' scope
                parentLayerId = tokenLayerId;
                parentType = 'primary token layer';
              }
              
              updateProgress(50, `Creating span layer: ${field.name} (${field.scope})...`);
              const spanLayer = await client.spanLayers.create(parentLayerId, field.name);
              
              // Set the scope in the span layer's config
              await client.spanLayers.setConfig(spanLayer.id, "plaid", "scope", field.scope);
              
              createdSpanLayers.push(spanLayer);
            } catch (fieldError) {
              console.warn(`Failed to create span layer for field ${field.name}:`, fieldError);
            }
          }
        }
        
        resources.spanLayers = createdSpanLayers;
      }

      // Step 7: Configure ignored tokens on token layer
      if (tokenLayerId && setupData.fields?.ignoredTokens) {
        updateProgress(60, 'Configuring ignored tokens...');
        const ignoredTokensConfig = {
          type: setupData.fields.ignoredTokens.mode === 'unicode-punctuation' ? 'unicodePunctuation' : 'blacklist'
        };
        
        if (ignoredTokensConfig.type === 'unicodePunctuation') {
          ignoredTokensConfig.whitelist = setupData.fields.ignoredTokens.unicodePunctuationExceptions || [];
        } else {
          ignoredTokensConfig.blacklist = setupData.fields.ignoredTokens.explicitIgnoredTokens || [];
        }
        
        await client.tokenLayers.setConfig(tokenLayerId, "plaid", "ignoredTokens", ignoredTokensConfig);
      }

      // Step 8: Handle vocabularies
      if (setupData.vocabulary?.vocabularies?.length > 0) {
        updateProgress(70, 'Configuring vocabularies...');
        const enabledVocabs = setupData.vocabulary.vocabularies.filter(vocab => vocab.enabled);
        const vocabulariesProcessed = [];
        
        for (const vocab of enabledVocabs) {
          try {
            if (vocab.isCustom && vocab.id.startsWith('new-')) {
              // Create new vocabulary
              updateProgress(70, `Creating vocabulary: ${vocab.name}...`);
              const newVocab = await client.vocabLayers.create(vocab.name);
              // Link to project using the actual ID from the created vocabulary
              await client.projects.linkVocab(currentProjectId, newVocab.id);
              vocabulariesProcessed.push(newVocab);
            } else {
              // Link existing vocabulary
              updateProgress(70, `Linking vocabulary: ${vocab.name}...`);
              await client.projects.linkVocab(currentProjectId, vocab.id);
              vocabulariesProcessed.push(vocab);
            }
          } catch (vocabError) {
            console.warn(`Failed to process vocabulary ${vocab.name}:`, vocabError);
            // Continue with other vocabularies rather than failing completely
          }
        }
        resources.vocabularies = vocabulariesProcessed;
      }

      // Step 9: Configure document metadata
      updateProgress(80, 'Configuring document metadata...');
      
      // Use configured fields if available, otherwise use predefined defaults
      let enabledFields = setupData.documentMetadata?.enabledFields?.filter(field => field.enabled) || [];
      
      // If no document metadata was configured, use the default enabled fields
      if (!setupData.documentMetadata?.enabledFields) {
        const defaultFields = [
          { name: 'Date', enabled: true, isCustom: false },
          { name: 'Speakers', enabled: true, isCustom: false },
          { name: 'Location', enabled: true, isCustom: false },
          { name: 'Genre', enabled: false, isCustom: false },
          { name: 'Recording Quality', enabled: false, isCustom: false },
          { name: 'Transcriber', enabled: false, isCustom: false }
        ];
        enabledFields = defaultFields.filter(field => field.enabled);
      }
      
      const metadataConfig = enabledFields.map(field => ({
        name: field.name
      }));
      await client.projects.setConfig(currentProjectId, "plaid", "documentMetadata", metadataConfig);

      // Step 10: Mark project as initialized
      updateProgress(90, 'Finalizing setup...');
      await client.projects.setConfig(currentProjectId, "plaid", "initialized", true);

      // Complete
      updateProgress(100, 'Setup complete!');
      setCreatedResources(resources);
      setIsComplete(true);

      notifications.show({
        title: 'Setup Complete',
        message: 'Your project has been successfully configured with Plaid Base.',
        color: 'green'
      });

      // Redirect
      navigate(`/projects/${currentProjectId}`);

    } catch (error) {
      console.error('Setup failed:', error);
      setErrors(prev => [...prev, `Setup failed: ${error.message}`]);
      
      notifications.show({
        title: 'Setup Failed',
        message: error.message,
        color: 'red'
      });
    } finally {
      setIsExecuting(false);
    }
  };

  // Review Section Components
  const ProjectInfoReview = () => (
    <Paper p="md" withBorder>
      <Text fw={500} mb="sm">Project Information</Text>
      {isNewProject && setupData.basicInfo?.projectName && (
        <Text size="sm">
          <strong>Project Name:</strong> {setupData.basicInfo.projectName}
        </Text>
      )}
      {!isNewProject && (
        <Text size="sm">
          <strong>Project ID:</strong> {projectId}
        </Text>
      )}
    </Paper>
  );

  const LayerSelectionReview = () => {
    const layerData = setupData.layerSelection;

    // For new projects there's no layerSelection step, but we still want to
    // show the user the token/morpheme layer names they're about to create.
    // Text layer is fixed to "Main Text" for new projects, so we hide that
    // row to keep the review concise.
    if (isNewProject) {
      return (
        <Paper p="md" withBorder>
          <Text fw={500} mb="sm">Layer Configuration</Text>
          <Stack spacing="xs">
            <Group>
              <Text size="sm" fw={500}>Token Layer:</Text>
              <Badge color="green">New: Main Tokens</Badge>
            </Group>
            <Group>
              <Text size="sm" fw={500}>Morpheme Layer:</Text>
              <Badge color="green">New: Main Morphemes</Badge>
            </Group>
          </Stack>
        </Paper>
      );
    }

    if (!layerData) return null;

    return (
      <Paper p="md" withBorder>
        <Text fw={500} mb="sm">Layer Configuration</Text>
        <Stack spacing="xs">
          <Group>
            <Text size="sm" fw={500}>Text Layer:</Text>
            {layerData.textLayerType === 'existing' ? (
              <Badge color="blue">Existing: {layerData.selectedTextLayerId}</Badge>
            ) : layerData.textLayerType === 'new' ? (
              <Badge color="green">New: {layerData.newTextLayerName}</Badge>
            ) : (
              <Badge color="gray">Not configured</Badge>
            )}
          </Group>
          <Group>
            <Text size="sm" fw={500}>Token Layer:</Text>
            <Badge color="green">New: {layerData.newTokenLayerName || 'Main Tokens'}</Badge>
          </Group>
          <Group>
            <Text size="sm" fw={500}>Morpheme Layer:</Text>
            <Badge color="green">New: {layerData.newMorphemeLayerName || 'Main Morphemes'}</Badge>
          </Group>
        </Stack>
      </Paper>
    );
  };

  const DocumentMetadataReview = () => {
    const metadataData = setupData.documentMetadata;
    if (!metadataData?.enabledFields?.length) return null;

    const enabledFields = metadataData.enabledFields.filter(field => field.enabled);
    if (enabledFields.length === 0) return null;

    return (
      <Paper p="md" withBorder>
        <Text fw={500} mb="sm">Document Metadata Fields</Text>
        <List size="sm">
          {enabledFields.map(field => (
            <List.Item key={field.name}>
              {field.name} {field.isCustom && <Badge size="xs" color="orange">Custom</Badge>}
            </List.Item>
          ))}
        </List>
      </Paper>
    );
  };

  const OrthographiesReview = () => {
    const orthographiesData = setupData.orthographies;
    if (!orthographiesData?.orthographies?.length) return null;

    return (
      <Paper p="md" withBorder>
        <Text fw={500} mb="sm">Orthographies</Text>
        <List size="sm">
          {orthographiesData.orthographies.map(orth => (
            <List.Item key={orth.name}>
              {orth.name} {orth.isBaseline && <Badge size="xs" color="blue">Baseline</Badge>}
            </List.Item>
          ))}
        </List>
      </Paper>
    );
  };

  const FieldsReview = () => {
    const fieldsData = setupData.fields;
    if (!fieldsData?.fields?.length) return null;

    return (
      <Paper p="md" withBorder>
        <Text fw={500} mb="sm">Annotation Fields</Text>
        <List size="sm">
          {fieldsData.fields.map(field => (
            <List.Item key={field.name}>
              {field.name} - <Badge size="xs" color={field.scope === 'Word' ? 'blue' : field.scope === 'Morpheme' ? 'violet' : 'green'}>{field.scope}</Badge>
            </List.Item>
          ))}
        </List>
        {fieldsData.ignoredTokens && (
          <div style={{ marginTop: '1rem' }}>
            <Text size="sm" fw={500} mb="xs">Ignored Tokens Configuration:</Text>
            <Text size="sm">
              Mode: {fieldsData.ignoredTokens.mode === 'unicode-punctuation' ? 'Unicode Punctuation' : 'Explicit List'}
            </Text>
            {fieldsData.ignoredTokens.mode === 'unicode-punctuation' && fieldsData.ignoredTokens.unicodePunctuationExceptions?.length > 0 && (
              <Text size="sm">
                Exceptions: {fieldsData.ignoredTokens.unicodePunctuationExceptions.join(', ')}
              </Text>
            )}
            {fieldsData.ignoredTokens.mode === 'explicit-list' && fieldsData.ignoredTokens.explicitIgnoredTokens?.length > 0 && (
              <Text size="sm">
                Ignored: {fieldsData.ignoredTokens.explicitIgnoredTokens.join(', ')}
              </Text>
            )}
          </div>
        )}
      </Paper>
    );
  };

  const VocabularyReview = () => {
    const vocabData = setupData.vocabulary;
    if (!vocabData?.vocabularies?.length) return null;

    const enabledVocabs = vocabData.vocabularies.filter(vocab => vocab.enabled);
    if (enabledVocabs.length === 0) return null;

    return (
      <Paper p="md" withBorder>
        <Text fw={500} mb="sm">Enabled Vocabularies</Text>
        <List size="sm">
          {enabledVocabs.map(vocab => (
            <List.Item key={vocab.name}>
              {vocab.name} {vocab.isCustom && <Badge size="xs" color="orange">New</Badge>}
            </List.Item>
          ))}
        </List>
      </Paper>
    );
  };

  if (isComplete) {
    return (
      <Stack spacing="lg">
        <Alert color="green" title="Setup Complete!" icon={<IconCheck size={16} />}>
          Your project has been successfully configured with Plaid Base. Redirecting to project...
        </Alert>
        <Paper p="md" withBorder>
          <Text fw={500} mb="sm">Setup Summary</Text>
          <Stack spacing="xs">
            {createdResources.project && (
              <Text size="sm">✓ Project created: {createdResources.project.name}</Text>
            )}
            {createdResources.textLayer && (
              <Text size="sm">✓ Text layer: {createdResources.textLayer.name}</Text>
            )}
            {createdResources.tokenLayer && (
              <Text size="sm">✓ Token layer: {createdResources.tokenLayer.name}</Text>
            )}
            {createdResources.morphemeLayer && (
              <Text size="sm">✓ Morpheme layer: {createdResources.morphemeLayer.name}</Text>
            )}
            {createdResources.sentenceTokenLayer && (
              <Text size="sm">✓ Sentence token layer: {createdResources.sentenceTokenLayer.name}</Text>
            )}
            {createdResources.alignmentTokenLayer && (
              <Text size="sm">✓ Alignment token layer: {createdResources.alignmentTokenLayer.name}</Text>
            )}
            {createdResources.spanLayers?.length > 0 && (
              <Text size="sm">✓ Span layers: {createdResources.spanLayers.map(layer => layer.name).join(', ')}</Text>
            )}
            {createdResources.vocabularies?.length > 0 && (
              <Text size="sm">✓ Vocabularies: {createdResources.vocabularies.length} configured</Text>
            )}
          </Stack>
        </Paper>
        <Group justify="center">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">Redirecting to project...</Text>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack spacing="lg">
      <Text size="md">
        Please review your choices below.
      </Text>

      <Stack spacing="md">
        <ProjectInfoReview />
        <LayerSelectionReview />
        <DocumentMetadataReview />
        <OrthographiesReview />
        <FieldsReview />
        <VocabularyReview />
        
        {/* Show message if no optional configuration is provided */}
        {!setupData.documentMetadata?.enabledFields?.some(f => f.enabled) && 
         !setupData.orthographies?.orthographies?.length && 
         !setupData.fields?.fields?.length && 
         !setupData.vocabulary?.vocabularies?.some(v => v.enabled) && (
          <Paper p="md" withBorder>
            <Text fw={500} mb="sm">Additional Configuration</Text>
            <Text size="sm" c="dimmed">
              No additional configuration selected. You can add document metadata, orthographies, 
              annotation fields, and vocabularies later through the project settings.
            </Text>
          </Paper>
        )}
      </Stack>

      <Divider />

      {errors.length > 0 && (
        <Alert color="red" title="Setup Errors" icon={<IconX size={16} />}>
          <Stack spacing="xs">
            {errors.map((error, index) => (
              <Text key={index} size="sm">{error}</Text>
            ))}
          </Stack>
        </Alert>
      )}

      {isExecuting && (
        <Paper p="md" withBorder>
          <Stack spacing="sm">
            <Group>
              <Loader size="sm" />
              <Text fw={500}>Executing Setup...</Text>
            </Group>
            <Progress value={progress} animated />
            <Text size="sm" c="dimmed">{currentOperation}</Text>
          </Stack>
        </Paper>
      )}

      <Group justify="flex-end">
        {errors.length > 0 && (
          <Button
            leftSection={<IconRefresh size={16} />}
            onClick={executeSetup}
            disabled={isExecuting}
            loading={isExecuting}
            color="orange"
          >
            Retry Setup
          </Button>
        )}
        <Button
          leftSection={<IconPlayerPlay size={16} />}
          onClick={executeSetup}
          disabled={isExecuting}
          loading={isExecuting}
        >
          {isNewProject ? "Create Project" : "Initialize Project"}
        </Button>
      </Group>
    </Stack>
  );
};

// Validation function for this step
ConfirmationStep.isValid = (data) => {
  // The confirmation step is always valid - it's just for review and execution
  return true;
};