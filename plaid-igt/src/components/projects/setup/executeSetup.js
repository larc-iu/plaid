// The project-setup executor, shared by the wizard's ConfirmationStep and the
// FLEx import flow. Pure async logic — UI state stays in the callers, which
// receive progress via onProgress(percent, message).
//
// Resume safety (unchanged from the original ConfirmationStep implementation):
//  - pass resumeProjectId to run against a project created by a prior partial
//    attempt instead of creating a duplicate (onProjectCreated reports a fresh
//    creation so the caller can remember it);
//  - substrate layers are adopted by shared role, span layers are reused by
//    name+parent, and vocabularies already linked are not re-created;
//  - a text layer, token layer or vocabulary an interrupted run made but did
//    not get to tag or link is finished rather than made again (see "ONE RULE
//    FOR COMPLETE" below);
//  - the initialized flag is only written when no step failed.
//
// Returns { projectId, resources, failures, alreadyInitialized }.

import {
  PLAID_NAMESPACE,
  PRESERVE_ON_SPLIT_KEY,
  PROVENANCE_KEYS,
  ROLE_KEY,
  ROLES,
} from '@larc-iu/plaid-client';
// Relative (not @/) import keeps this module loadable from plain-node e2e
// scripts, which drive the real setup against the live core.
import {
  IGT_NAMESPACE,
  readInitialized,
  findBaselineTextLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
  findMorphemeTokenLayer,
  findAlignmentTokenLayer,
  storedIgnoredTokens,
} from '../../../domain/igtConfig.js';
import { seedDefaultFields } from '../../../domain/vocabFields.js';
import { statusFieldSeed } from '../../../domain/vocabDictionary.js';

// The text layer's name is internal (it is matched by role, never surfaced),
// so it is also what identifies one this setup made before it was tagged.
const BASELINE_LAYER_NAME = 'Main Text';

// ONE RULE FOR "COMPLETE". Everything setup makes takes two requests: a
// create, and a write that says what the thing is (the role tag on a text or
// token layer, the link on a vocabulary). A lost response between the two
// leaves something no later look for the finished shape can see, and a resume
// that only looks for the finished shape makes a second one and strands the
// first. So every kind is looked for twice: first as finished, then as
// half made, by the name and shape it carries before the second write.
//
// `unfinishedLayer` is that second look for a text or token layer. The
// vocabulary's is at step 8, where the unlinked ones are read.
const unfinishedLayer = (layers, name, matches = () => true) =>
  (layers || []).find(
    (l) => l.name === name && !l.config?.[PLAID_NAMESPACE]?.[ROLE_KEY] && matches(l),
  ) || null;

// The whole setup (project + layers + config + vocabularies) is ONE logical
// operation in the audit log; each write keeps its own description underneath.
export async function executeProjectSetup(args) {
  const name = args.setupData?.basicInfo?.projectName?.trim();
  return args.client.withOperation(name ? `Set up project "${name}"` : 'Set up project', () =>
    executeProjectSetupImpl(args),
  );
}

async function executeProjectSetupImpl({
  client,
  isNewProject,
  resumeProjectId,
  setupData,
  onProgress,
  onProjectCreated,
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
        return {
          projectId: resumeProjectId,
          resources: {},
          failures: [],
          alreadyInitialized: true,
        };
      }
    } catch (checkError) {
      // Substrate adoption and retry dedup both read existingProject —
      // proceeding without it could duplicate role-tagged layers (which
      // breaks findPrimaryLayers) or re-create vocabs. Fail the attempt.
      throw new Error(`Could not load the project to set up: ${checkError.message}`, {
        cause: checkError,
      });
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
  // Made by an interrupted run and not yet tagged. Nothing else makes a text
  // layer of this name in this project, so it is finished rather than made a
  // second time (which left the untagged one behind for good).
  //
  // Only where this run would otherwise CREATE one. Setting up over a project
  // that already has its text, the wizard asks which text layer to build on
  // and that answer is the step: an untagged "Main Text" from some earlier
  // attempt is not a better answer to it, and taking it silently tags and
  // builds under a layer the documents have no text on.
  const wouldCreateBaseline = isNewProject || setupData.layerSelection?.textLayerType === 'new';
  const halfMadeBaseline =
    adoptedBaseline || !wouldCreateBaseline
      ? null
      : unfinishedLayer(existingTextLayers, BASELINE_LAYER_NAME);
  const baselineLayer = adoptedBaseline ?? halfMadeBaseline;

  let textLayerId = baselineLayer?.id ?? null;
  let needsBaselineTag = !!halfMadeBaseline;
  if (adoptedBaseline) {
    updateProgress(20, 'Using shared text layer...');
    // Adopted baseline already carries role=baseline — no re-stamp needed.
  } else if (halfMadeBaseline) {
    updateProgress(20, 'Using existing text layer...');
  } else if (isNewProject) {
    updateProgress(20, 'Creating text layer...');
    const textLayer = await client.textLayers.create(currentProjectId, BASELINE_LAYER_NAME);
    textLayerId = textLayer.id;
    resources.textLayer = textLayer;
    needsBaselineTag = true;
  } else if (setupData.layerSelection?.textLayerType === 'new') {
    updateProgress(20, 'Creating text layer...');
    const textLayer = await client.textLayers.create(currentProjectId, BASELINE_LAYER_NAME);
    textLayerId = textLayer.id;
    resources.textLayer = textLayer;
    needsBaselineTag = true;
  } else if (
    setupData.layerSelection?.textLayerType === 'existing' &&
    setupData.layerSelection?.selectedTextLayerId
  ) {
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
    const existingTokenLayers = baselineLayer?.tokenLayers || [];

    // The same second look as the text layer's, with the shape a token layer
    // also carries: two of one name under one parent are different layers
    // unless their overlap mode and parent match too.
    const untagged = (name, overlapMode, parentId) =>
      unfinishedLayer(
        existingTokenLayers,
        name,
        (l) =>
          (l.overlapMode ?? null) === (overlapMode ?? null) &&
          (l.parentTokenLayer ?? l.parentTokenLayerId ?? null) === (parentId ?? null),
      );

    const ensureTokenLayer = async (
      found,
      role,
      resourceKey,
      name,
      overlapMode,
      parentId,
      pct,
      msg,
    ) => {
      let layer = found || untagged(name, overlapMode, parentId);
      if (!layer) {
        updateProgress(pct, msg);
        layer = await client.tokenLayers.create(textLayerId, name, overlapMode, parentId);
        resources[resourceKey] = layer;
      }
      const config = layer.config?.[PLAID_NAMESPACE] || {};
      if (config[ROLE_KEY] !== role) {
        await client.tokenLayers.setConfig(layer.id, PLAID_NAMESPACE, ROLE_KEY, role);
      }
      // Provenance survives a split, including one made by another app that
      // has never heard of these keys. See the manual's "Metadata Preserved
      // Across a Split" for why the layer has to say so rather than each app
      // remembering at each call site. Written whenever it is missing, so a
      // run that stopped between the two config writes is put right rather
      // than leaving the layer without it for good.
      if (!Array.isArray(config[PRESERVE_ON_SPLIT_KEY])) {
        await client.tokenLayers.setConfig(layer.id, PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY, [
          ...PROVENANCE_KEYS,
        ]);
      }
      return layer.id;
    };

    sentenceTokenLayerId = await ensureTokenLayer(
      findSentenceTokenLayer(existingTokenLayers),
      ROLES.SENTENCE,
      'sentenceTokenLayer',
      'Sentences',
      'partitioning',
      undefined,
      28,
      'Creating sentence layer...',
    );

    tokenLayerId = await ensureTokenLayer(
      findWordTokenLayer(existingTokenLayers),
      ROLES.WORD,
      'tokenLayer',
      'Main Tokens',
      'non-overlapping',
      sentenceTokenLayerId,
      32,
      'Creating token layer...',
    );

    morphemeLayerId = await ensureTokenLayer(
      findMorphemeTokenLayer(existingTokenLayers),
      ROLES.MORPHEME,
      'morphemeLayer',
      'Main Morphemes',
      'any',
      tokenLayerId,
      35,
      'Creating morpheme layer...',
    );

    await ensureTokenLayer(
      findAlignmentTokenLayer(existingTokenLayers),
      ROLES.TIME_ALIGNMENT,
      'alignmentTokenLayer',
      'Time Alignment',
      'non-overlapping',
      undefined,
      38,
      'Creating alignment token layer...',
    );
  }

  // Step 5: Configure orthographies on the word token layer
  if (tokenLayerId && setupData.orthographies?.orthographies) {
    updateProgress(40, 'Configuring orthographies...');
    const orthographiesConfig = setupData.orthographies.orthographies
      .filter((orth) => !orth.isBaseline)
      .map((orth) => ({ name: orth.name }));
    // Always save the config to indicate user choice, even if empty
    await client.tokenLayers.setConfig(
      tokenLayerId,
      IGT_NAMESPACE,
      'orthographies',
      orthographiesConfig,
    );
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
            field.scope === 'Sentence'
              ? sentenceTokenLayerId
              : field.scope === 'Morpheme'
                ? morphemeLayerId
                : tokenLayerId;

          updateProgress(50, `Creating span layer: ${field.name} (${field.scope})...`);
          const existing = (existingSpanLayersByParent.get(parentLayerId) || []).find(
            (sl) => sl.name === field.name,
          );
          const spanLayer = existing ?? (await client.spanLayers.create(parentLayerId, field.name));

          await client.spanLayers.setConfig(spanLayer.id, IGT_NAMESPACE, 'scope', field.scope);
          // What language its values are in, when the caller knows. An importer
          // reading a format that says so (FLEx writing systems, ELAN tier
          // names) is the only one that does.
          if (field.lang) {
            await client.spanLayers.setConfig(spanLayer.id, IGT_NAMESPACE, 'lang', field.lang);
          }
          createdSpanLayers.push(spanLayer);
        } catch (fieldError) {
          console.warn(`Failed to create span layer for field ${field.name}:`, fieldError);
          failures.push(
            `Annotation field "${field.name}" could not be created: ${fieldError.message}`,
          );
        }
      }
    }

    resources.spanLayers = createdSpanLayers;
  }

  // Step 7: Configure ignored tokens on the word token layer
  if (tokenLayerId && setupData.fields?.ignoredTokens) {
    updateProgress(60, 'Configuring ignored tokens...');
    await client.tokenLayers.setConfig(
      tokenLayerId,
      IGT_NAMESPACE,
      'ignoredTokens',
      storedIgnoredTokens(setupData.fields.ignoredTokens),
    );
  }

  // Step 8: Vocabularies. Resume-safe: already-linked vocabs are reused, and
  // so is one an interrupted run made and did not get to link.
  if (setupData.vocabulary?.vocabularies?.length > 0) {
    updateProgress(70, 'Configuring vocabularies...');
    const enabledVocabs = setupData.vocabulary.vocabularies.filter((vocab) => vocab.enabled);
    const linkedVocabs = existingProject?.vocabs || [];
    const vocabulariesProcessed = [];

    // The vocabulary's half-made shape: created, not linked. A project read
    // names only the linked ones, so the rest are read once and only on a
    // resume, where a half-made one can exist. Never fatal: without the list
    // this is the behaviour it had before, which is to make a second one.
    let unlinked = null;
    const madeEarlier = async (name) => {
      if (!existingProject) return null;
      if (!unlinked) {
        const linkedIds = new Set(linkedVocabs.map((v) => v.id));
        let all = [];
        try {
          all = (await client.vocabLayers.list()) || [];
        } catch (listError) {
          console.warn('Could not list vocabularies while resuming setup:', listError);
        }
        unlinked = all.filter((v) => !linkedIds.has(v.id));
      }
      return unlinked.find((v) => v.name === name) ?? null;
    };

    for (const vocab of enabledVocabs) {
      try {
        if (vocab.isCustom && vocab.id.startsWith('new-')) {
          const alreadyLinked = linkedVocabs.find((v) => v.name === vocab.name);
          if (alreadyLinked) {
            vocabulariesProcessed.push(alreadyLinked);
            continue;
          }
          let newVocab = await madeEarlier(vocab.name);
          if (!newVocab) {
            updateProgress(70, `Creating vocabulary: ${vocab.name}...`);
            newVocab = await client.vocabLayers.create(vocab.name);
          }
          // A new vocabulary starts with the core fields plus Status and its
          // list, the same setup every creation path does (statusFieldSeed).
          // Written only where it is missing, so finishing one an earlier run
          // started does not overwrite what that run already put there.
          const igt = newVocab.config?.[IGT_NAMESPACE] || {};
          const add = statusFieldSeed({ fieldsConfig: seedDefaultFields(), tagsets: {} });
          if (!igt.tagsets) {
            await client.vocabLayers.setConfig(newVocab.id, IGT_NAMESPACE, 'tagsets', add.tagsets);
          }
          if (!igt.fields) {
            await client.vocabLayers.setConfig(
              newVocab.id,
              IGT_NAMESPACE,
              'fields',
              add.fieldsConfig,
            );
          }
          await client.projects.linkVocab(currentProjectId, newVocab.id);
          vocabulariesProcessed.push(newVocab);
        } else {
          if (linkedVocabs.some((v) => v.id === vocab.id)) {
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
  let enabledFields =
    setupData.documentMetadata?.enabledFields?.filter((field) => field.enabled) || [];
  if (!setupData.documentMetadata?.enabledFields) {
    const defaultFields = [
      { name: 'Date', enabled: true, isCustom: false },
      { name: 'Speakers', enabled: true, isCustom: false },
      { name: 'Location', enabled: true, isCustom: false },
      { name: 'Genre', enabled: false, isCustom: false },
      { name: 'Recording Quality', enabled: false, isCustom: false },
      { name: 'Transcriber', enabled: false, isCustom: false },
    ];
    enabledFields = defaultFields.filter((field) => field.enabled);
  }
  await client.projects.setConfig(
    currentProjectId,
    IGT_NAMESPACE,
    'documentMetadata',
    enabledFields.map((field) => ({ name: field.name })),
  );

  // Step 10: Mark initialized — ONLY if every step succeeded.
  if (failures.length === 0) {
    updateProgress(90, 'Finalizing setup...');
    await client.projects.setConfig(currentProjectId, IGT_NAMESPACE, 'initialized', true);
  }

  return { projectId: currentProjectId, resources, failures, alreadyInitialized: false };
}
