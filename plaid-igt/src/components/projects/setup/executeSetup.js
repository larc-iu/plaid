// The project-setup executor, shared by the wizard's ConfirmationStep and the
// FLEx import flow. Pure async logic — UI state stays in the callers, which
// receive progress via onProgress(percent, message).
//
// Resume safety (unchanged from the original ConfirmationStep implementation):
//  - pass resumeProjectId to run against a project created by a prior partial
//    attempt instead of creating a duplicate (onProjectCreated reports a fresh
//    creation so the caller can remember it);
//  - substrate layers are adopted by shared role; span layers are reused by
//    name+parent; vocabularies already linked are not re-created;
//  - the initialized flag is only written when no step failed.
//
// Returns { projectId, resources, failures, alreadyInitialized }.

import { PLAID_NAMESPACE, ROLE_KEY, ROLES } from '@larc-iu/plaid-client';
import {
  IGT_NAMESPACE, readInitialized,
  findBaselineTextLayer, findSentenceTokenLayer, findWordTokenLayer,
  findMorphemeTokenLayer, findAlignmentTokenLayer,
} from '@/domain/igtConfig';

export async function executeProjectSetup({
  client, isNewProject, resumeProjectId, setupData, onProgress, onProjectCreated,
}) {
  const updateProgress = (pct, msg) => onProgress?.(pct, msg);

  // Refuse to re-run setup on an already-initialized project. Re-running
  // would create a second set of plaid-tagged layers and break
  // findPrimaryLayers (which returns the first match). Token-layer overlap
  // modes and parent-token-layer ids are immutable, so we cannot adopt the
  // existing layers either — the user must create a new project instead.
  // Fetched once here and reused for substrate adoption below (no 2nd GET).
  let existingProject = null;
  if (resumeProjectId) {
    try {
      existingProject = await client.projects.get(resumeProjectId);
      if (readInitialized(existingProject?.config)) {
        return { projectId: resumeProjectId, resources: {}, failures: [], alreadyInitialized: true };
      }
    } catch (checkError) {
      // Substrate adoption and retry dedup both read existingProject —
      // proceeding without it could duplicate role-tagged layers (which
      // breaks findPrimaryLayers) or re-create vocabs. Fail the attempt.
      throw new Error(`Could not load the project to set up: ${checkError.message}`);
    }
  }

  let currentProjectId = resumeProjectId || null;
  const resources = {};
  // Non-fatal step failures (span layers, vocabularies). Setup only marks
  // the project initialized when this stays empty — a partially set up
  // project must not present as ready.
  const failures = [];

  // Step 1: Create project if new (skip if a prior attempt already did).
  if (isNewProject && !resumeProjectId && setupData.basicInfo?.projectName) {
    updateProgress(10, 'Creating new project...');
    const newProject = await client.projects.create(setupData.basicInfo.projectName);
    currentProjectId = newProject.id;
    resources.project = newProject;
    onProjectCreated?.(newProject.id);
  }

  // Step 2: Find or create the substrate, ADOPTING a shared substrate that
  // another Plaid app may already have set up (matched by shared role).
  const existingTextLayers = existingProject?.textLayers || [];
  const adoptedBaseline = findBaselineTextLayer(existingTextLayers);

  let textLayerId = adoptedBaseline?.id ?? null;
  let needsBaselineTag = false;
  if (textLayerId) {
    updateProgress(20, 'Using shared text layer...');
    // Adopted baseline already carries role=baseline — no re-stamp needed.
  } else if (isNewProject) {
    updateProgress(20, 'Creating text layer...');
    const textLayer = await client.textLayers.create(currentProjectId, 'Main Text');
    textLayerId = textLayer.id;
    resources.textLayer = textLayer;
    needsBaselineTag = true;
  } else if (setupData.layerSelection?.textLayerType === 'new') {
    updateProgress(20, 'Creating text layer...');
    // Text layer name is internal (matched by role, never surfaced) — auto-named.
    const textLayer = await client.textLayers.create(currentProjectId, 'Main Text');
    textLayerId = textLayer.id;
    resources.textLayer = textLayer;
    needsBaselineTag = true;
  } else if (setupData.layerSelection?.textLayerType === 'existing' && setupData.layerSelection?.selectedTextLayerId) {
    textLayerId = setupData.layerSelection.selectedTextLayerId;
    updateProgress(20, 'Using existing text layer...');
    needsBaselineTag = true;
  }
  if (needsBaselineTag && textLayerId) {
    await client.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
  }

  // Token layers, matched-or-created by role: sentence → word → morpheme,
  // plus a separate alignment root.
  let sentenceTokenLayerId = null;
  let tokenLayerId = null;
  let morphemeLayerId = null;

  if (textLayerId) {
    const existingTokenLayers = adoptedBaseline?.tokenLayers || [];

    const ensureTokenLayer = async (found, role, resourceKey, name, overlapMode, parentId, pct, msg) => {
      if (found) return found.id;
      updateProgress(pct, msg);
      const layer = await client.tokenLayers.create(textLayerId, name, overlapMode, parentId);
      resources[resourceKey] = layer;
      await client.tokenLayers.setConfig(layer.id, PLAID_NAMESPACE, ROLE_KEY, role);
      return layer.id;
    };

    sentenceTokenLayerId = await ensureTokenLayer(
      findSentenceTokenLayer(existingTokenLayers), ROLES.SENTENCE, 'sentenceTokenLayer',
      'Sentences', 'partitioning', undefined, 28, 'Creating sentence layer...');

    tokenLayerId = await ensureTokenLayer(
      findWordTokenLayer(existingTokenLayers), ROLES.WORD, 'tokenLayer',
      'Main Tokens', 'non-overlapping', sentenceTokenLayerId, 32, 'Creating token layer...');

    morphemeLayerId = await ensureTokenLayer(
      findMorphemeTokenLayer(existingTokenLayers), ROLES.MORPHEME, 'morphemeLayer',
      'Main Morphemes', 'any', tokenLayerId, 35, 'Creating morpheme layer...');

    await ensureTokenLayer(
      findAlignmentTokenLayer(existingTokenLayers), ROLES.TIME_ALIGNMENT, 'alignmentTokenLayer',
      'Time Alignment', 'non-overlapping', undefined, 38, 'Creating alignment token layer...');
  }

  // Step 5: Configure orthographies on the word token layer
  if (tokenLayerId && setupData.orthographies?.orthographies) {
    updateProgress(40, 'Configuring orthographies...');
    const orthographiesConfig = setupData.orthographies.orthographies
      .filter(orth => !orth.isBaseline)
      .map(orth => ({ name: orth.name }));
    // Always save the config to indicate user choice, even if empty
    await client.tokenLayers.setConfig(tokenLayerId, IGT_NAMESPACE, 'orthographies', orthographiesConfig);
  }

  // Step 6: Create span layers for annotation fields. Resume-safe: reuse a
  // same-name layer under the chosen parent and just (re)stamp its scope.
  if (tokenLayerId && sentenceTokenLayerId) {
    updateProgress(50, 'Creating annotation field layers...');
    const createdSpanLayers = [];

    const existingSpanLayersByParent = new Map();
    for (const tl of existingProject?.textLayers || []) {
      for (const tkl of tl.tokenLayers || []) {
        existingSpanLayersByParent.set(tkl.id, tkl.spanLayers || []);
      }
    }

    if (setupData.fields?.fields?.length > 0) {
      for (const field of setupData.fields.fields) {
        try {
          const parentLayerId =
            field.scope === 'Sentence' ? sentenceTokenLayerId :
            field.scope === 'Morpheme' ? morphemeLayerId :
            tokenLayerId;

          updateProgress(50, `Creating span layer: ${field.name} (${field.scope})...`);
          const existing = (existingSpanLayersByParent.get(parentLayerId) || [])
            .find(sl => sl.name === field.name);
          const spanLayer = existing ?? await client.spanLayers.create(parentLayerId, field.name);

          await client.spanLayers.setConfig(spanLayer.id, IGT_NAMESPACE, 'scope', field.scope);
          createdSpanLayers.push(spanLayer);
        } catch (fieldError) {
          console.warn(`Failed to create span layer for field ${field.name}:`, fieldError);
          failures.push(`Annotation field "${field.name}" could not be created: ${fieldError.message}`);
        }
      }
    }

    resources.spanLayers = createdSpanLayers;
  }

  // Step 7: Configure ignored tokens on the word token layer
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
    await client.tokenLayers.setConfig(tokenLayerId, IGT_NAMESPACE, 'ignoredTokens', ignoredTokensConfig);
  }

  // Step 8: Vocabularies. Resume-safe: already-linked vocabs are reused.
  if (setupData.vocabulary?.vocabularies?.length > 0) {
    updateProgress(70, 'Configuring vocabularies...');
    const enabledVocabs = setupData.vocabulary.vocabularies.filter(vocab => vocab.enabled);
    const linkedVocabs = existingProject?.vocabs || [];
    const vocabulariesProcessed = [];

    for (const vocab of enabledVocabs) {
      try {
        if (vocab.isCustom && vocab.id.startsWith('new-')) {
          const alreadyLinked = linkedVocabs.find(v => v.name === vocab.name);
          if (alreadyLinked) {
            vocabulariesProcessed.push(alreadyLinked);
            continue;
          }
          updateProgress(70, `Creating vocabulary: ${vocab.name}...`);
          const newVocab = await client.vocabLayers.create(vocab.name);
          await client.projects.linkVocab(currentProjectId, newVocab.id);
          vocabulariesProcessed.push(newVocab);
        } else {
          if (linkedVocabs.some(v => v.id === vocab.id)) {
            vocabulariesProcessed.push(vocab);
            continue;
          }
          updateProgress(70, `Linking vocabulary: ${vocab.name}...`);
          await client.projects.linkVocab(currentProjectId, vocab.id);
          vocabulariesProcessed.push(vocab);
        }
      } catch (vocabError) {
        console.warn(`Failed to process vocabulary ${vocab.name}:`, vocabError);
        failures.push(`Vocabulary "${vocab.name}" could not be set up: ${vocabError.message}`);
      }
    }
    resources.vocabularies = vocabulariesProcessed;
  }

  // Step 9: Configure document metadata
  updateProgress(80, 'Configuring document metadata...');
  let enabledFields = setupData.documentMetadata?.enabledFields?.filter(field => field.enabled) || [];
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
  await client.projects.setConfig(currentProjectId, IGT_NAMESPACE, 'documentMetadata',
    enabledFields.map(field => ({ name: field.name })));

  // Step 10: Mark initialized — ONLY if every step succeeded.
  if (failures.length === 0) {
    updateProgress(90, 'Finalizing setup...');
    await client.projects.setConfig(currentProjectId, IGT_NAMESPACE, 'initialized', true);
  }

  return { projectId: currentProjectId, resources, failures, alreadyInitialized: false };
}
