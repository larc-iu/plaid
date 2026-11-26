import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { notifySuccess, notifyError, humanizeError } from '@/utils/feedback';
import { executeProjectSetup } from './executeSetup';
import { IGNORED_TOKEN_MODES } from '@/domain/igtConfig';
import { scopeBadgeClass } from '@/domain/scopeColors';
import { t } from '@ui/lib/i18n.js';

// The names setup gives the layers it makes (executeSetup.js).
const TEXT = 'Main Text'; // i18n-ignore: a layer name, stored
const TOKENS = 'Main Tokens'; // i18n-ignore: a layer name, stored
const MORPHEMES = 'Main Morphemes'; // i18n-ignore: a layer name, stored

export const ConfirmationStep = ({ setupData, isNewProject, projectId, client, onPrevious }) => {
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
  // The ids setup names on the project and vocabularies it makes, kept across
  // presses of Retry (executeSetup.js `mints`).
  const mints = useRef({}).current;

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
        throw new Error(t('Authentication required'));
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
        mints,
      });

      if (result.alreadyInitialized) {
        notifyError(
          t('This project is already set up for Plaid IGT. Create a new project instead.'),
          t('Already set up'),
        );
        return;
      }

      // A partial project must not present as ready; the user retries
      // (resume-safe) until everything is in place.
      if (result.failures.length > 0) {
        setErrors(result.failures);
        notifyError(
          t(
            '{n, plural, one {# setup step} other {# setup steps}} failed. The project is not ready until Retry setup finishes.',
            { n: result.failures.length },
          ),
          t('Setup incomplete'),
        );
        return;
      }

      updateProgress(100, t('Setup complete'));
      setCreatedResources(result.resources);
      setIsComplete(true);

      notifySuccess(t('Setup complete'));

      navigate(`/projects/${result.projectId}`);
    } catch (error) {
      console.error('Setup failed:', error);
      setErrors((prev) => [...prev, humanizeError(error)]);

      notifyError(humanizeError(error), t('Failed to set up the project'));
    } finally {
      setIsExecuting(false);
    }
  };

  // Review Section Components
  const ProjectInfoReview = () => (
    <div className="rounded-lg border bg-card p-4">
      <p className="mb-2 font-medium">{t('Project')}</p>
      <p className="text-sm">
        <strong>{t('Name:')}</strong> {setupData.basicInfo?.projectName}
      </p>
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
          <p className="mb-2 font-medium">{t('Layers')}</p>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">{t('Token layer:')}</p>
              <Badge className="border-transparent bg-success/15 text-success-foreground">
                {t('New: {name}', { name: TOKENS })}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">{t('Morpheme layer:')}</p>
              <Badge className="border-transparent bg-success/15 text-success-foreground">
                {t('New: {name}', { name: MORPHEMES })}
              </Badge>
            </div>
          </div>
        </div>
      );
    }

    if (!layerData) return null;

    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 font-medium">{t('Layers')}</p>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{t('Text layer:')}</p>
            {layerData.textLayerType === 'adopted' ? (
              <Badge variant="secondary">{t('Reusing existing baseline')}</Badge>
            ) : layerData.textLayerType === 'existing' ? (
              <Badge variant="secondary">
                {t('Existing: {name}', { name: layerData.selectedTextLayerName })}
              </Badge>
            ) : layerData.textLayerType === 'new' ? (
              <Badge className="border-transparent bg-success/15 text-success-foreground">
                {t('New: {name}', { name: TEXT })}
              </Badge>
            ) : (
              <Badge variant="secondary">{t('Not configured')}</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{t('Token layer:')}</p>
            <Badge className="border-transparent bg-success/15 text-success-foreground">
              {TOKENS}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{t('Morpheme layer:')}</p>
            <Badge className="border-transparent bg-success/15 text-success-foreground">
              {MORPHEMES}
            </Badge>
          </div>
        </div>
      </div>
    );
  };

  const DocumentMetadataReview = () => {
    const metadataData = setupData.documentMetadata;
    if (!metadataData?.enabledFields?.length) return null;

    const enabledFields = metadataData.enabledFields.filter((field) => field.enabled);
    if (enabledFields.length === 0) return null;

    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 font-medium">{t('Document metadata fields')}</p>
        <ul className="list-disc pl-5 text-sm">
          {enabledFields.map((field) => (
            <li key={`${field.scope}-${field.name}`}>
              {field.name} {field.isCustom && <Badge variant="secondary">{t('Custom')}</Badge>}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  // What the Orthographies step lists: the additional orthographies, never
  // the Baseline as one of them.
  const OrthographiesReview = () => {
    const orthographiesData = setupData.orthographies;
    if (!orthographiesData?.orthographies?.length) return null;
    const additional = orthographiesData.orthographies.filter((orth) => !orth.isBaseline);

    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 font-medium">{t('Additional orthographies')}</p>
        {additional.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('None')}</p>
        ) : (
          <ul className="list-disc pl-5 text-sm">
            {additional.map((orth) => (
              <li key={orth.name}>{orth.name}</li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const FieldsReview = () => {
    const fieldsData = setupData.fields;
    if (!fieldsData?.fields?.length) return null;

    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 font-medium">{t('Annotation fields')}</p>
        <ul className="list-disc pl-5 text-sm">
          {fieldsData.fields.map((field) => (
            <li key={`${field.scope}-${field.name}`}>
              {field.name} -{' '}
              <Badge className={scopeBadgeClass(field.scope)}>
                {t(
                  '{scope, select, Word {Word} Morpheme {Morpheme} Sentence {Sentence} other {{scope}}}',
                  { scope: field.scope },
                )}
              </Badge>
            </li>
          ))}
        </ul>
        {fieldsData.ignoredTokens && (
          <div className="mt-4">
            <p className="mb-1 text-sm font-medium">{t('Ignored tokens:')}</p>
            <p className="text-sm">
              {fieldsData.ignoredTokens.mode === IGNORED_TOKEN_MODES.punctuation
                ? t('Mode: Unicode punctuation')
                : t('Mode: Explicit list')}
            </p>
            {fieldsData.ignoredTokens.mode === IGNORED_TOKEN_MODES.punctuation &&
              fieldsData.ignoredTokens.unicodePunctuationExceptions?.length > 0 && (
                <p className="text-sm">
                  {t('Exceptions: {tokens}', {
                    tokens: fieldsData.ignoredTokens.unicodePunctuationExceptions.join(', '),
                  })}
                </p>
              )}
            {fieldsData.ignoredTokens.mode === IGNORED_TOKEN_MODES.explicit &&
              fieldsData.ignoredTokens.explicitIgnoredTokens?.length > 0 && (
                <p className="text-sm">
                  {t('Ignored: {tokens}', {
                    tokens: fieldsData.ignoredTokens.explicitIgnoredTokens.join(', '),
                  })}
                </p>
              )}
          </div>
        )}
      </div>
    );
  };

  const VocabularyReview = () => {
    // A Vocabulary step left as it came links nothing, and says so here too.
    const enabledVocabs = (setupData.vocabulary?.vocabularies || []).filter(
      (vocab) => vocab.enabled,
    );
    // Say "none" rather than disappearing. This section used to render nothing
    // when nothing was linked, which is the one outcome worth reviewing: the
    // step's on/off column is a bare check mark that toggles on a row click, so
    // a stray click near the row's edge unlinks a vocabulary with no other
    // feedback, and the review was then silent about it. A project finished
    // that way looks right and has an empty lexicon.
    if (enabledVocabs.length === 0) {
      return (
        <div className="rounded-lg border bg-card p-4">
          <p className="mb-2 font-medium">{t('Vocabulary')}</p>
          <p className="text-sm text-muted-foreground">
            {t('No vocabulary linked. Words and morphemes will have no lexicon to link to.')}
          </p>
        </div>
      );
    }

    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 font-medium">{t('Vocabulary')}</p>
        <ul className="list-disc pl-5 text-sm">
          {enabledVocabs.map((vocab) => (
            <li key={vocab.name}>
              {vocab.name}{' '}
              {vocab.isCustom && (
                <Badge className="border-transparent bg-success/15 text-success-foreground">
                  {t('New')}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  if (isComplete) {
    return (
      <div className="flex flex-col gap-6">
        <Notice tone="success" className="p-4">
          <p className="font-medium">{t('Setup complete')}</p>
        </Notice>
        <div className="rounded-lg border bg-card p-4">
          <p className="mb-2 font-medium">{t('Summary')}</p>
          <div className="flex flex-col gap-2">
            {createdResources.project && (
              <p className="text-sm">
                ✓ {t('Project created: {name}', { name: createdResources.project.name })}
              </p>
            )}
            {createdResources.textLayer && (
              <p className="text-sm">
                ✓ {t('Text layer: {name}', { name: createdResources.textLayer.name })}
              </p>
            )}
            {createdResources.tokenLayer && (
              <p className="text-sm">
                ✓ {t('Token layer: {name}', { name: createdResources.tokenLayer.name })}
              </p>
            )}
            {createdResources.morphemeLayer && (
              <p className="text-sm">
                ✓ {t('Morpheme layer: {name}', { name: createdResources.morphemeLayer.name })}
              </p>
            )}
            {createdResources.sentenceTokenLayer && (
              <p className="text-sm">
                ✓{' '}
                {t('Sentence token layer: {name}', {
                  name: createdResources.sentenceTokenLayer.name,
                })}
              </p>
            )}
            {createdResources.alignmentTokenLayer && (
              <p className="text-sm">
                ✓{' '}
                {t('Alignment token layer: {name}', {
                  name: createdResources.alignmentTokenLayer.name,
                })}
              </p>
            )}
            {createdResources.spanLayers?.length > 0 && (
              <p className="text-sm">
                ✓{' '}
                {t('Span layers: {names}', {
                  names: createdResources.spanLayers.map((layer) => layer.name).join(', '),
                })}
              </p>
            )}
            {createdResources.vocabularies?.length > 0 && (
              <p className="text-sm">
                ✓ {t('Vocabularies: {n} linked', { n: createdResources.vocabularies.length })}
              </p>
            )}
          </div>
        </div>
        <Loading label={t('Opening the project…')} className="p-0 text-center" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p>{t('Review your choices.')}</p>

      <div className="flex flex-col gap-4">
        {isNewProject && <ProjectInfoReview />}
        {!isNewProject && <LayerSelectionReview />}
        <DocumentMetadataReview />
        <OrthographiesReview />
        <FieldsReview />
        <VocabularyReview />

        {/* Show message if no optional configuration is provided */}
        {!setupData.documentMetadata?.enabledFields?.some((f) => f.enabled) &&
          !setupData.orthographies?.orthographies?.length &&
          !setupData.fields?.fields?.length &&
          !setupData.vocabulary?.vocabularies?.some((v) => v.enabled) && (
            <div className="rounded-lg border bg-card p-4">
              <p className="mb-2 font-medium">{t('Other settings')}</p>
              <p className="text-sm text-muted-foreground">
                {t(
                  'None chosen. Document metadata, orthographies, annotation fields and vocabularies are under Settings.',
                )}
              </p>
            </div>
          )}
      </div>

      <hr className="border-border" />

      {errors.length > 0 && (
        <Notice tone="error" className="p-4">
          <p className="font-medium">{t('Setup errors')}</p>
          <div className="mt-1 flex flex-col gap-2">
            {errors.map((error, index) => (
              <p key={index} className="text-muted-foreground">
                {error}
              </p>
            ))}
          </div>
        </Notice>
      )}

      {isExecuting && (
        <div className="rounded-lg border bg-card p-4">
          <div className="flex flex-col gap-2">
            <p className="font-medium">{t('Setting up…')}</p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-sm text-muted-foreground">{currentOperation}</p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-4">
        <Button variant="outline" onClick={onPrevious} disabled={isExecuting || !onPrevious}>
          {t('Previous')}
        </Button>
        <div className="flex items-center gap-2">
          {errors.length > 0 && (
            <Button variant="outline" onClick={executeSetup} disabled={isExecuting}>
              <RefreshCw className="h-4 w-4" /> {t('Retry setup')}
            </Button>
          )}
          <Button onClick={executeSetup} disabled={isExecuting}>
            {isNewProject ? t('Create project') : t('Set up project')}
          </Button>
        </div>
      </div>
    </div>
  );
};

// Validation function for this step
ConfirmationStep.isValid = () => {
  // The confirmation step is always valid - it's just for review and execution
  return true;
};
