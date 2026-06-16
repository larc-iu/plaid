import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, X, RefreshCw, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { executeProjectSetup } from './executeSetup';

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

  // Execute setup — the actual logic lives in executeSetup.js (shared with
  // the FLEx import flow); this wrapper owns the wizard's UI state.
  const executeSetup = async () => {
    setIsExecuting(true);
    setErrors([]);
    setProgress(0);
    setCreatedResources({});

    try {
      if (!client) {
        throw new Error('Authentication required');
      }

      // If a previous attempt in this wizard session already created the
      // project (NEW flow that failed partway), resume against that id
      // rather than creating a duplicate.
      const result = await executeProjectSetup({
        client,
        isNewProject,
        resumeProjectId: isNewProject ? createdProjectId : projectId,
        setupData,
        onProgress: updateProgress,
        // Persist immediately so a subsequent failure + retry won't recreate.
        onProjectCreated: setCreatedProjectId,
      });

      if (result.alreadyInitialized) {
        notifyError(
          'This project is already initialized with Plaid IGT. Re-running setup is not supported — create a new project instead.',
          'Project Already Initialized'
        );
        return;
      }

      // A partial project must not present as ready; the user retries
      // (resume-safe) until everything is in place.
      if (result.failures.length > 0) {
        setErrors(result.failures);
        notifyError(
          `${result.failures.length} setup step${result.failures.length === 1 ? '' : 's'} failed. ` +
          'The project has NOT been marked ready — fix the issue or use Retry Setup to finish.',
          'Setup Incomplete'
        );
        return;
      }

      updateProgress(100, 'Setup complete!');
      setCreatedResources(result.resources);
      setIsComplete(true);

      notifySuccess(
        'Your project has been successfully configured with Plaid IGT.',
        'Setup Complete'
      );

      navigate(`/projects/${result.projectId}`);

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
            {layerData.textLayerType === 'adopted' ? (
              <Badge className="border-transparent bg-blue-100 text-blue-700">Reusing existing baseline</Badge>
            ) : layerData.textLayerType === 'existing' ? (
              <Badge className="border-transparent bg-blue-100 text-blue-700">Existing: {layerData.selectedTextLayerId}</Badge>
            ) : layerData.textLayerType === 'new' ? (
              <Badge className="border-transparent bg-green-100 text-green-700">New: Main Text</Badge>
            ) : (
              <Badge variant="secondary">Not configured</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Token Layer:</p>
            <Badge className="border-transparent bg-green-100 text-green-700">Main Tokens</Badge>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Morpheme Layer:</p>
            <Badge className="border-transparent bg-green-100 text-green-700">Main Morphemes</Badge>
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
                Your project has been successfully configured with Plaid IGT. Redirecting to project...
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
