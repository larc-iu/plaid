import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, X, RefreshCw, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { PLAID_NAMESPACE, ROLE_KEY, ROLES } from '@larc-iu/plaid-client';
import {
  IGT_NAMESPACE, readInitialized,
  findBaselineTextLayer, findSentenceTokenLayer, findWordTokenLayer,
  findMorphemeTokenLayer, findAlignmentTokenLayer,
} from '@/domain/igtConfig';

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
          if (readInitialized(existingProject?.config)) {
            notifyError(
              'This project is already initialized with Plaid Base. Re-running setup is not supported — create a new project instead.',
              'Project Already Initialized'
            );
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

      // Step 2: Find or create the substrate, ADOPTING a shared substrate that
      // another Plaid app may already have set up. Substrate layers are matched
      // by their shared role, so we reuse an existing baseline/sentence/word
      // rather than duplicating them, and create only what IGT additionally
      // needs (its morpheme + alignment layers). New projects have no substrate,
      // so this finds nothing and creates the whole skeleton.
      let existingTextLayers = [];
      try {
        const proj = await client.projects.get(currentProjectId);
        existingTextLayers = proj?.textLayers || [];
      } catch { /* brand-new / empty project: nothing to adopt */ }
      const adoptedBaseline = findBaselineTextLayer(existingTextLayers);

      let textLayerId = adoptedBaseline?.id ?? null;
      if (textLayerId) {
        updateProgress(20, 'Using shared text layer...');
        await client.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
      } else if (isNewProject) {
        updateProgress(20, 'Creating text layer...');
        const textLayer = await client.textLayers.create(currentProjectId, 'Main Text');
        textLayerId = textLayer.id;
        resources.textLayer = textLayer;
        await client.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
      } else if (setupData.layerSelection?.textLayerType === 'new' && setupData.layerSelection?.newTextLayerName) {
        updateProgress(20, 'Creating text layer...');
        const textLayer = await client.textLayers.create(currentProjectId, setupData.layerSelection.newTextLayerName);
        textLayerId = textLayer.id;
        resources.textLayer = textLayer;
        await client.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
      } else if (setupData.layerSelection?.textLayerType === 'existing' && setupData.layerSelection?.selectedTextLayerId) {
        textLayerId = setupData.layerSelection.selectedTextLayerId;
        updateProgress(20, 'Using existing text layer...');
        await client.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
      }

      // Token layers, matched-or-created by role: sentence → word → morpheme,
      // plus a separate alignment root. Adopting a foreign substrate reuses its
      // sentence/word and adds only IGT's morpheme + alignment layers (the
      // morpheme layer becomes a sibling of e.g. UD's syntactic-word layer).
      let sentenceTokenLayerId = null;
      let tokenLayerId = null;
      let morphemeLayerId = null;
      let alignmentTokenLayerId = null;

      if (textLayerId) {
        const existingTokenLayers = (adoptedBaseline?.id === textLayerId ? adoptedBaseline?.tokenLayers : []) || [];

        // Sentence (partitioning root)
        const foundSentence = findSentenceTokenLayer(existingTokenLayers);
        if (foundSentence) {
          sentenceTokenLayerId = foundSentence.id;
        } else {
          updateProgress(28, 'Creating sentence layer...');
          const sentenceTokenLayer = await client.tokenLayers.create(textLayerId, 'Sentences', 'partitioning');
          sentenceTokenLayerId = sentenceTokenLayer.id;
          resources.sentenceTokenLayer = sentenceTokenLayer;
          await client.tokenLayers.setConfig(sentenceTokenLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SENTENCE);
        }

        // Word (non-overlapping, nested in sentence)
        const foundWord = findWordTokenLayer(existingTokenLayers);
        if (foundWord) {
          tokenLayerId = foundWord.id;
        } else {
          const tokenLayerName = (!isNewProject && setupData.layerSelection?.newTokenLayerName)
            ? setupData.layerSelection.newTokenLayerName
            : 'Main Tokens';
          updateProgress(32, 'Creating token layer...');
          const tokenLayer = await client.tokenLayers.create(textLayerId, tokenLayerName, 'non-overlapping', sentenceTokenLayerId);
          tokenLayerId = tokenLayer.id;
          resources.tokenLayer = tokenLayer;
          await client.tokenLayers.setConfig(tokenLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.WORD);
        }

        // Morpheme (any, nested in word) — IGT-specific; a UD substrate has none.
        const foundMorpheme = findMorphemeTokenLayer(existingTokenLayers);
        if (foundMorpheme) {
          morphemeLayerId = foundMorpheme.id;
        } else {
          const morphemeLayerName = (!isNewProject && setupData.layerSelection?.newMorphemeLayerName)
            ? setupData.layerSelection.newMorphemeLayerName
            : 'Main Morphemes';
          updateProgress(35, 'Creating morpheme layer...');
          const morphemeLayer = await client.tokenLayers.create(textLayerId, morphemeLayerName, 'any', tokenLayerId);
          morphemeLayerId = morphemeLayer.id;
          resources.morphemeLayer = morphemeLayer;
          await client.tokenLayers.setConfig(morphemeLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.MORPHEME);
        }

        // Alignment (non-overlapping root, time-aligned)
        const foundAlignment = findAlignmentTokenLayer(existingTokenLayers);
        if (foundAlignment) {
          alignmentTokenLayerId = foundAlignment.id;
        } else {
          updateProgress(38, 'Creating alignment token layer...');
          const alignmentTokenLayer = await client.tokenLayers.create(textLayerId, 'Time Alignment', 'non-overlapping');
          alignmentTokenLayerId = alignmentTokenLayer.id;
          resources.alignmentTokenLayer = alignmentTokenLayer;
          await client.tokenLayers.setConfig(alignmentTokenLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.TIME_ALIGNMENT);
        }
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
        await client.tokenLayers.setConfig(tokenLayerId, IGT_NAMESPACE, "orthographies", orthographiesConfig);
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
              await client.spanLayers.setConfig(spanLayer.id, IGT_NAMESPACE, "scope", field.scope);

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

        await client.tokenLayers.setConfig(tokenLayerId, IGT_NAMESPACE, "ignoredTokens", ignoredTokensConfig);
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
      await client.projects.setConfig(currentProjectId, IGT_NAMESPACE, "documentMetadata", metadataConfig);

      // Step 10: Mark project as initialized
      updateProgress(90, 'Finalizing setup...');
      await client.projects.setConfig(currentProjectId, IGT_NAMESPACE, "initialized", true);

      // Complete
      updateProgress(100, 'Setup complete!');
      setCreatedResources(resources);
      setIsComplete(true);

      notifySuccess(
        'Your project has been successfully configured with Plaid Base.',
        'Setup Complete'
      );

      // Redirect
      navigate(`/projects/${currentProjectId}`);

    } catch (error) {
      console.error('Setup failed:', error);
      setErrors(prev => [...prev, `Setup failed: ${error.message}`]);

      notifyError(error.message, 'Setup Failed');
    } finally {
      setIsExecuting(false);
    }
  };

  // Review Section Components
  const ProjectInfoReview = () => (
    <div className="rounded-lg border bg-card p-4">
      <p className="mb-2 font-medium">Project Information</p>
      {isNewProject && setupData.basicInfo?.projectName && (
        <p className="text-sm">
          <strong>Project Name:</strong> {setupData.basicInfo.projectName}
        </p>
      )}
      {!isNewProject && (
        <p className="text-sm">
          <strong>Project ID:</strong> {projectId}
        </p>
      )}
    </div>
  );

  const LayerSelectionReview = () => {
    const layerData = setupData.layerSelection;

    // For new projects there's no layerSelection step, but we still want to
    // show the user the token/morpheme layer names they're about to create.
    // Text layer is fixed to "Main Text" for new projects, so we hide that
    // row to keep the review concise.
    if (isNewProject) {
      return (
        <div className="rounded-lg border bg-card p-4">
          <p className="mb-2 font-medium">Layer Configuration</p>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">Token Layer:</p>
              <Badge className="border-transparent bg-green-100 text-green-700">New: Main Tokens</Badge>
            </div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">Morpheme Layer:</p>
              <Badge className="border-transparent bg-green-100 text-green-700">New: Main Morphemes</Badge>
            </div>
          </div>
        </div>
      );
    }

    if (!layerData) return null;

    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 font-medium">Layer Configuration</p>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Text Layer:</p>
            {layerData.textLayerType === 'existing' ? (
              <Badge className="border-transparent bg-blue-100 text-blue-700">Existing: {layerData.selectedTextLayerId}</Badge>
            ) : layerData.textLayerType === 'new' ? (
              <Badge className="border-transparent bg-green-100 text-green-700">New: {layerData.newTextLayerName}</Badge>
            ) : (
              <Badge variant="secondary">Not configured</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Token Layer:</p>
            <Badge className="border-transparent bg-green-100 text-green-700">New: {layerData.newTokenLayerName || 'Main Tokens'}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Morpheme Layer:</p>
            <Badge className="border-transparent bg-green-100 text-green-700">New: {layerData.newMorphemeLayerName || 'Main Morphemes'}</Badge>
          </div>
        </div>
      </div>
    );
  };

  const DocumentMetadataReview = () => {
    const metadataData = setupData.documentMetadata;
    if (!metadataData?.enabledFields?.length) return null;

    const enabledFields = metadataData.enabledFields.filter(field => field.enabled);
    if (enabledFields.length === 0) return null;

    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 font-medium">Document Metadata Fields</p>
        <ul className="list-disc pl-5 text-sm">
          {enabledFields.map(field => (
            <li key={field.name}>
              {field.name} {field.isCustom && <Badge className="border-transparent bg-orange-100 text-orange-700">Custom</Badge>}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const OrthographiesReview = () => {
    const orthographiesData = setupData.orthographies;
    if (!orthographiesData?.orthographies?.length) return null;

    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 font-medium">Orthographies</p>
        <ul className="list-disc pl-5 text-sm">
          {orthographiesData.orthographies.map(orth => (
            <li key={orth.name}>
              {orth.name} {orth.isBaseline && <Badge className="border-transparent bg-blue-100 text-blue-700">Baseline</Badge>}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const FieldsReview = () => {
    const fieldsData = setupData.fields;
    if (!fieldsData?.fields?.length) return null;

    const scopeBadgeClasses = {
      'Word': 'border-transparent bg-blue-100 text-blue-700',
      'Morpheme': 'border-transparent bg-violet-100 text-violet-700',
      'Sentence': 'border-transparent bg-green-100 text-green-700'
    };

    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 font-medium">Annotation Fields</p>
        <ul className="list-disc pl-5 text-sm">
          {fieldsData.fields.map(field => (
            <li key={field.name}>
              {field.name} - <Badge className={scopeBadgeClasses[field.scope]}>{field.scope}</Badge>
            </li>
          ))}
        </ul>
        {fieldsData.ignoredTokens && (
          <div className="mt-4">
            <p className="mb-1 text-sm font-medium">Ignored Tokens Configuration:</p>
            <p className="text-sm">
              Mode: {fieldsData.ignoredTokens.mode === 'unicode-punctuation' ? 'Unicode Punctuation' : 'Explicit List'}
            </p>
            {fieldsData.ignoredTokens.mode === 'unicode-punctuation' && fieldsData.ignoredTokens.unicodePunctuationExceptions?.length > 0 && (
              <p className="text-sm">
                Exceptions: {fieldsData.ignoredTokens.unicodePunctuationExceptions.join(', ')}
              </p>
            )}
            {fieldsData.ignoredTokens.mode === 'explicit-list' && fieldsData.ignoredTokens.explicitIgnoredTokens?.length > 0 && (
              <p className="text-sm">
                Ignored: {fieldsData.ignoredTokens.explicitIgnoredTokens.join(', ')}
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  const VocabularyReview = () => {
    const vocabData = setupData.vocabulary;
    if (!vocabData?.vocabularies?.length) return null;

    const enabledVocabs = vocabData.vocabularies.filter(vocab => vocab.enabled);
    if (enabledVocabs.length === 0) return null;

    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 font-medium">Enabled Vocabularies</p>
        <ul className="list-disc pl-5 text-sm">
          {enabledVocabs.map(vocab => (
            <li key={vocab.name}>
              {vocab.name} {vocab.isCustom && <Badge className="border-transparent bg-orange-100 text-orange-700">New</Badge>}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  if (isComplete) {
    return (
      <div className="tw flex flex-col gap-6">
        <div className="rounded-md border border-border bg-muted p-4">
          <div className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
            <div className="text-sm">
              <p className="font-medium">Setup Complete!</p>
              <p className="mt-1 text-muted-foreground">
                Your project has been successfully configured with Plaid Base. Redirecting to project...
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="mb-2 font-medium">Setup Summary</p>
          <div className="flex flex-col gap-2">
            {createdResources.project && (
              <p className="text-sm">✓ Project created: {createdResources.project.name}</p>
            )}
            {createdResources.textLayer && (
              <p className="text-sm">✓ Text layer: {createdResources.textLayer.name}</p>
            )}
            {createdResources.tokenLayer && (
              <p className="text-sm">✓ Token layer: {createdResources.tokenLayer.name}</p>
            )}
            {createdResources.morphemeLayer && (
              <p className="text-sm">✓ Morpheme layer: {createdResources.morphemeLayer.name}</p>
            )}
            {createdResources.sentenceTokenLayer && (
              <p className="text-sm">✓ Sentence token layer: {createdResources.sentenceTokenLayer.name}</p>
            )}
            {createdResources.alignmentTokenLayer && (
              <p className="text-sm">✓ Alignment token layer: {createdResources.alignmentTokenLayer.name}</p>
            )}
            {createdResources.spanLayers?.length > 0 && (
              <p className="text-sm">✓ Span layers: {createdResources.spanLayers.map(layer => layer.name).join(', ')}</p>
            )}
            {createdResources.vocabularies?.length > 0 && (
              <p className="text-sm">✓ Vocabularies: {createdResources.vocabularies.length} configured</p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-center gap-2">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
          <p className="text-sm text-muted-foreground">Redirecting to project...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tw flex flex-col gap-6">
      <p>
        Please review your choices below.
      </p>

      <div className="flex flex-col gap-4">
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
          <div className="rounded-lg border bg-card p-4">
            <p className="mb-2 font-medium">Additional Configuration</p>
            <p className="text-sm text-muted-foreground">
              No additional configuration selected. You can add document metadata, orthographies,
              annotation fields, and vocabularies later through the project settings.
            </p>
          </div>
        )}
      </div>

      <hr className="border-border" />

      {errors.length > 0 && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4">
          <div className="flex items-start gap-2">
            <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="text-sm">
              <p className="font-medium text-destructive">Setup Errors</p>
              <div className="mt-1 flex flex-col gap-2">
                {errors.map((error, index) => (
                  <p key={index} className="text-muted-foreground">{error}</p>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {isExecuting && (
        <div className="rounded-lg border bg-card p-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
              <p className="font-medium">Executing Setup...</p>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-sm text-muted-foreground">{currentOperation}</p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {errors.length > 0 && (
          <Button
            variant="outline"
            onClick={executeSetup}
            disabled={isExecuting}
          >
            <RefreshCw className="h-4 w-4" /> Retry Setup
          </Button>
        )}
        <Button
          onClick={executeSetup}
          disabled={isExecuting}
        >
          <Play className="h-4 w-4" /> {isNewProject ? "Create Project" : "Initialize Project"}
        </Button>
      </div>
    </div>
  );
};

// Validation function for this step
ConfirmationStep.isValid = (data) => {
  // The confirmation step is always valid - it's just for review and execution
  return true;
};
