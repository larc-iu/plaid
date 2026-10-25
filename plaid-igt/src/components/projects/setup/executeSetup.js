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
//
// `setupData.substrateOnly` (`{roles}`) is a native archive of a project igt
// never set up (Luke's ruling R37): only the project, the baseline text layer
// and the shared token layers named in `roles` are made, each with its role
// and nothing else, and the vocabularies are made and linked unseeded. No
// igt config, field, rule or initialized flag is written. What else those
// layers hold the archive puts back as it was.

import {
  IGNORED_TOKENS_KEY,
  PLAID_NAMESPACE,
  PRESERVE_ON_SPLIT_KEY,
  PROVENANCE_KEYS,
  ROLE_KEY,
  ROLES,
  SPLIT_ON_SPACE_KEY,
  uuidv7,
} from '@larc-iu/plaid-client';
import {
  declarePreserveOnSplit,
  declareSplitOnSpace,
  preservesOnSplit,
  splitsOnSpace,
} from '../../../../../plaid-ui/src/domain/substrateConfig.js';
// Relative (not @/) import keeps this module loadable from plain-node e2e
// scripts, which drive the real setup against the live core.
import {
  IGT_NAMESPACE,
  LEXICON_FIELD_KEY,
  SENTENCE_ROLE_KEY,
  readImportState,
  readInitialized,
  findBaselineTextLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
  findMorphemeTokenLayer,
  findAlignmentTokenLayer,
  readScope,
  storedIgnoredTokens,
} from '../../../domain/igtConfig.js';
import { seedDefaultFields } from '../../../domain/vocabFields.js';
import {
  declareIgtRules,
  morphemeLayerConstraints,
  queueNewField,
  wordLayerConstraints,
} from '../../../domain/igtConstraints.js';
import { nameKey, sameName } from '../../../../../plaid-ui/src/lib/nameKey.js';
import { createOnce } from '../../../../../plaid-ui/src/lib/createOnce.js';
import { statusFieldSeed } from '../../../domain/vocabDictionary.js';
import { importRepairs } from '../../../domain/importFinish.js';
import { proposeServiceFieldDefaults } from '../../../domain/serviceFieldDefaults.js';
import { entryRolesByKey } from '../../../domain/lexiconField.js';
import { withSentenceRoles } from '../../../domain/sentenceRole.js';

// The text layer's name is internal (it is matched by role, never surfaced),
// so it is also what identifies one this setup made before it was tagged.
const BASELINE_LAYER_NAME = 'Main Text';

// ONE RULE FOR "COMPLETE". A vocabulary takes two requests: a create, and the
// link that says it is this project's. A lost response between the two leaves
// something no later look for the finished shape can see, so the vocabulary
// is looked for twice, at step 8, where the unlinked ones are read. A text,
// token or span layer is made in one batch with its role tag (and its rules),
// so it is never half made, and a layer without a role is never setup's,
// whatever it is called.

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
  onVocabCreated,
  // Where the ids of the project and each vocabulary this setup makes are
  // kept between presses (createOnce.js): the caller holds one object for
  // the life of its screen, so a press after an answer that never came names
  // the same ids and opens what the first made rather than making a second.
  mints = {},
}) {
  const mintOf = (key) => (mints[key] ??= { current: null });
  const updateProgress = (pct, msg) => onProgress?.(pct, msg);
  // Igt's own setup, or only the shared substrate another app's project had.
  const substrateRoles = setupData.substrateOnly ? new Set(setupData.substrateOnly.roles) : null;
  const igt = !substrateRoles;

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
    updateProgress(10, 'Creating new project…');
    // Keyed by the name, as the vocabularies are: a name changed in review
    // after a lost answer mints a fresh id rather than opening the old one.
    const projectName = setupData.basicInfo.projectName;
    const newProject = await createOnce(mintOf(`project:${nameKey(projectName)}`), (id) =>
      client.projects.create(projectName, undefined, { id }),
    );
    currentProjectId = newProject.id;
    // An earlier press made it: createOnce answers its id alone.
    resources.project = { name: projectName, ...newProject };
    await onProjectCreated?.(newProject.id);
  }

  // Step 2: Find or create the substrate, ADOPTING a shared substrate that
  // another Plaid app may already have set up (matched by shared role).
  const existingTextLayers = existingProject?.textLayers || [];
  const adoptedBaseline = findBaselineTextLayer(existingTextLayers);

  // A text layer made here is made in one batch with its role.
  const createBaseline = async () => {
    updateProgress(20, 'Creating text layer…');
    const id = uuidv7();
    await client.batched((b) => {
      b.textLayers.create(currentProjectId, BASELINE_LAYER_NAME, undefined, { id });
      b.textLayers.setConfig(id, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
    });
    resources.textLayer = { id, name: BASELINE_LAYER_NAME };
    return id;
  };

  let textLayerId = adoptedBaseline?.id ?? null;
  let needsBaselineTag = false;
  if (adoptedBaseline) {
    updateProgress(20, 'Using shared text layer…');
    // Adopted baseline already carries role=baseline — no re-stamp needed.
  } else if (isNewProject || setupData.layerSelection?.textLayerType === 'new') {
    textLayerId = await createBaseline();
  } else if (
    setupData.layerSelection?.textLayerType === 'existing' &&
    setupData.layerSelection?.selectedTextLayerId
  ) {
    textLayerId = setupData.layerSelection.selectedTextLayerId;
    updateProgress(20, 'Using existing text layer…');
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

    const ensureTokenLayer = async (
      found,
      role,
      resourceKey,
      name,
      overlapMode,
      parentId,
      pct,
      msg,
      rules = null,
    ) => {
      let layer = found;
      if (!igt) {
        // Only a layer the archived project had, made with its role alone.
        if (!substrateRoles.has(role)) return layer?.id ?? null;
        if (layer) return layer.id;
        updateProgress(pct, msg);
        const id = uuidv7();
        await client.batched((b) => {
          b.tokenLayers.create(textLayerId, name, overlapMode, parentId, undefined, { id });
          b.tokenLayers.setConfig(id, PLAID_NAMESPACE, ROLE_KEY, role);
        });
        resources[resourceKey] = { id, name, config: { [PLAID_NAMESPACE]: { [ROLE_KEY]: role } } };
        return id;
      }
      if (!layer) {
        // A layer made here is made in one batch with its role, what a split
        // keeps, and IGT's rules for it. It is empty, so no data can refuse
        // the rules, and no failure after the batch leaves it without them.
        updateProgress(pct, msg);
        const id = uuidv7();
        const plaid = { [ROLE_KEY]: role, [PRESERVE_ON_SPLIT_KEY]: [...PROVENANCE_KEYS] };
        if (role === ROLES.WORD) plaid[SPLIT_ON_SPACE_KEY] = true;
        await client.batched((b) => {
          b.tokenLayers.create(textLayerId, name, overlapMode, parentId, undefined, { id });
          b.tokenLayers.setConfig(id, PLAID_NAMESPACE, ROLE_KEY, role);
          declarePreserveOnSplit(b, id);
          if (role === ROLES.WORD) declareSplitOnSpace(b, id);
          if (rules) {
            b.tokenLayers.setConstraints(id, IGT_NAMESPACE, rules, undefined, { expected: null });
          }
        });
        layer = { id, name, config: { [PLAID_NAMESPACE]: plaid } };
        resources[resourceKey] = layer;
      }
      // Provenance survives a split, including one made by another app that
      // has never heard of these keys. See the manual's "Metadata Preserved
      // Across a Split" for why the layer has to say so rather than each app
      // remembering at each call site. Written whenever it is missing, so a
      // run that stopped between the two config writes is put right rather
      // than leaving the layer without it for good. The word layer another
      // app made splits a word at a typed space, as one made here does.
      if (!preservesOnSplit(layer)) await declarePreserveOnSplit(client, layer.id);
      if (role === ROLES.WORD && !splitsOnSpace(layer)) await declareSplitOnSpace(client, layer.id);
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
      'Creating sentence layer…',
    );

    tokenLayerId = await ensureTokenLayer(
      findWordTokenLayer(existingTokenLayers),
      ROLES.WORD,
      'tokenLayer',
      'Main Tokens',
      'non-overlapping',
      sentenceTokenLayerId,
      32,
      'Creating token layer…',
      wordLayerConstraints(),
    );

    morphemeLayerId = await ensureTokenLayer(
      findMorphemeTokenLayer(existingTokenLayers),
      ROLES.MORPHEME,
      'morphemeLayer',
      'Main Morphemes',
      'any',
      tokenLayerId,
      35,
      'Creating morpheme layer…',
      morphemeLayerConstraints(),
    );

    await ensureTokenLayer(
      findAlignmentTokenLayer(existingTokenLayers),
      ROLES.TIME_ALIGNMENT,
      'alignmentTokenLayer',
      'Time Alignment',
      'non-overlapping',
      undefined,
      38,
      'Creating alignment token layer…',
    );
  }

  // Step 5: Configure orthographies on the word token layer
  if (igt && tokenLayerId && setupData.orthographies?.orthographies) {
    updateProgress(40, 'Configuring orthographies…');
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

  // Each field setup made or reused, with its scope and id.
  const madeFields = [];

  // Step 6: Create span layers for annotation fields. Resume-safe: a layer an
  // earlier run made under the chosen parent was made in one batch with its
  // scope, so it is known by that scope, and its name tells it from the other
  // fields of that scope. A layer without the scope is never setup's, whatever
  // it is called (another app's, or one made through the API): the field gets
  // a layer of its own beside it.
  if (igt && tokenLayerId && sentenceTokenLayerId) {
    updateProgress(50, 'Creating annotation field layers…');
    const createdSpanLayers = [];

    const existingSpanLayersByParent = new Map();
    for (const tl of existingProject?.textLayers || []) {
      for (const tkl of tl.tokenLayers || []) {
        existingSpanLayersByParent.set(tkl.id, tkl.spanLayers || []);
      }
    }
    // The span layers under each parent as they stand, in order: the ones the
    // project read named, then each one this run makes, which core puts last.
    const siblings = new Map(
      [...existingSpanLayersByParent].map(([parent, layers]) => [parent, layers.map((l) => l.id)]),
    );
    // Which field each layer is, by its place in the fields list.
    const fieldIndexOf = new Map();

    if (setupData.fields?.fields?.length > 0) {
      // A sentence field that states no role gets the one its name proposes,
      // here, where it is made.
      for (const field of withSentenceRoles(setupData.fields.fields)) {
        try {
          const parentLayerId =
            field.scope === 'Sentence'
              ? sentenceTokenLayerId
              : field.scope === 'Morpheme'
                ? morphemeLayerId
                : tokenLayerId;

          updateProgress(50, `Creating span layer: ${field.name} (${field.scope})…`);
          const existing = (existingSpanLayersByParent.get(parentLayerId) || []).find(
            // name-ok: within one project, a layer igt's own scope already marks
            (sl) => readScope(sl.config) === field.scope && sl.name === field.name,
          );
          // What language its values are in, when the caller knows. An importer
          // reading a format that says so (FLEx writing systems, ELAN tier
          // names) is the only one that does.
          let spanLayer = existing;
          if (existing) {
            if (field.lang) {
              await client.spanLayers.setConfig(existing.id, IGT_NAMESPACE, 'lang', field.lang);
            }
            if (field.lexiconField) {
              await client.spanLayers.setConfig(
                existing.id,
                IGT_NAMESPACE,
                LEXICON_FIELD_KEY,
                field.lexiconField,
              );
            }
            if (field.scope === 'Sentence' && field.sentenceRole) {
              await client.spanLayers.setConfig(
                existing.id,
                IGT_NAMESPACE,
                SENTENCE_ROLE_KEY,
                field.sentenceRole,
              );
            }
          } else {
            // Made in one batch with its scope, language, Lexicon field, role
            // and rules.
            let id;
            await client.batched((b) => {
              id = queueNewField(b, parentLayerId, field, existingProject?.config);
            });
            spanLayer = { id, name: field.name };
            siblings.set(parentLayerId, [...(siblings.get(parentLayerId) || []), id]);
          }
          fieldIndexOf.set(spanLayer.id, fieldIndexOf.size);
          createdSpanLayers.push(spanLayer);
          madeFields.push({
            name: field.name,
            scope: field.scope,
            id: spanLayer.id,
            lexiconField: field.lexiconField ?? null,
            sentenceRole: field.sentenceRole ?? null,
          });
        } catch (fieldError) {
          console.warn(`Failed to create span layer for field ${field.name}:`, fieldError);
          failures.push(
            `Annotation field "${field.name}" could not be created: ${fieldError.message}`,
          );
        }
      }
    }

    resources.spanLayers = createdSpanLayers;

    // Imports keep field order. A field whose layer an interrupted run did
    // not get to make is made now, after the ones that run did make, so it is
    // moved up past every field that comes after it. Asked of the order as it
    // stands, so a run that stopped part way through moving it finishes the
    // move. Only for a new project: setting up over an existing one leaves
    // the order its layers already have.
    if (isNewProject) {
      for (const [parentId, ids] of siblings) {
        const order = [...ids];
        for (let i = 1; i < order.length; i++) {
          const mine = fieldIndexOf.get(order[i]);
          if (mine === undefined) continue;
          let at = i;
          while (at > 0 && (fieldIndexOf.get(order[at - 1]) ?? -1) > mine) {
            try {
              await client.spanLayers.shift(order[at], 'up');
            } catch (shiftError) {
              console.warn('Failed to order the annotation fields:', shiftError);
              failures.push(
                `The annotation fields could not be put in order: ${shiftError.message}`,
              );
              break;
            }
            [order[at - 1], order[at]] = [order[at], order[at - 1]];
            at -= 1;
          }
        }
        siblings.set(parentId, order);
      }
    }
  }

  // Step 6b: the project's default fields for igt's own services, proposed
  // once from the fields setup makes, never over what is stored. An archive
  // brings its own (`serviceFieldDefaults: false`).
  if (
    igt &&
    currentProjectId &&
    setupData.serviceFieldDefaults !== false &&
    existingProject?.config?.[IGT_NAMESPACE]?.serviceDefaults === undefined
  ) {
    const proposed = proposeServiceFieldDefaults(
      madeFields,
      entryRolesByKey(existingProject?.vocabs),
    );
    if (Object.keys(proposed).length) {
      await client.projects.setConfig(currentProjectId, IGT_NAMESPACE, 'serviceDefaults', proposed);
    }
  }

  // Step 7: Configure ignored tokens on the word token layer
  if (igt && tokenLayerId && setupData.fields?.ignoredTokens) {
    updateProgress(60, 'Configuring ignored tokens…');
    await client.tokenLayers.setConfig(
      tokenLayerId,
      PLAID_NAMESPACE,
      IGNORED_TOKENS_KEY,
      storedIgnoredTokens(setupData.fields.ignoredTokens),
    );
  }

  // Step 8: Vocabularies. Resume-safe: already-linked vocabs are reused, and
  // so is one an interrupted run made and did not get to link.
  if (setupData.vocabulary?.vocabularies?.length > 0) {
    updateProgress(70, 'Configuring vocabularies…');
    const enabledVocabs = setupData.vocabulary.vocabularies.filter((vocab) => vocab.enabled);
    const linkedVocabs = existingProject?.vocabs || [];
    const vocabulariesProcessed = [];

    // The vocabulary's half-made shape: created, not linked. A project read
    // names only the linked ones, so the rest are read once and only on a
    // resume, where a half-made one can exist. Never fatal: without the list
    // this is the behaviour it had before, which is to make a second one.
    //
    // WHICH of them is the import record's to say. `GET /vocab-layers` lists
    // every vocabulary the user can read, in any project, and its rows say
    // nothing about which project owns them: a name is shared by every run
    // of the same import, so matching on one linked a colleague's lexicon
    // into this project and wrote this import's entries into it. A run
    // records every vocabulary it makes, by name, the moment it exists
    // (onVocabCreated), so only one this project's own record names is
    // adopted. One recorded id was not enough: an import that makes several
    // vocabularies overwrote it with each, and a resume adopted the last and
    // made the others again.
    const madeVocabs = { ...(readImportState(existingProject?.config)?.vocabsMade ?? {}) };
    let unlinked = null;
    const madeEarlier = async (name) => {
      const recordedId = madeVocabs[nameKey(name)];
      if (!existingProject || !recordedId) return null;
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
      return unlinked.find((v) => v.id === recordedId && sameName(v.name, name)) ?? null;
    };

    for (const vocab of enabledVocabs) {
      try {
        if (vocab.isCustom && vocab.id.startsWith('new-')) {
          const alreadyLinked = linkedVocabs.find((v) => sameName(v.name, vocab.name));
          if (alreadyLinked) {
            vocabulariesProcessed.push(alreadyLinked);
            continue;
          }
          let newVocab = await madeEarlier(vocab.name);
          if (!newVocab) {
            updateProgress(70, `Creating vocabulary: ${vocab.name}…`);
            newVocab = await createOnce(mintOf(`vocab:${nameKey(vocab.name)}`), (id) =>
              client.vocabLayers.create(vocab.name, undefined, { id }),
            );
            // Said before it is linked, so a run that dies in between leaves
            // a record naming it and the next one finishes it rather than
            // making a second.
            madeVocabs[nameKey(vocab.name)] = newVocab.id;
            await onVocabCreated?.(newVocab.id, { ...madeVocabs });
          }
          // A new vocabulary starts with the core fields plus Status and its
          // list, the same setup every creation path does (statusFieldSeed).
          // Written only where it is missing, so finishing one an earlier run
          // started does not overwrite what that run already put there.
          const stored = newVocab.config?.[IGT_NAMESPACE] || {};
          const add = statusFieldSeed({ fieldsConfig: seedDefaultFields(), tagsets: {} });
          if (igt && !stored.tagsets) {
            await client.vocabLayers.setConfig(newVocab.id, IGT_NAMESPACE, 'tagsets', add.tagsets);
          }
          if (igt && !stored.fields) {
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
          updateProgress(70, `Linking vocabulary: ${vocab.name}…`);
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

  // The rest is igt's own: a project it does not set up is done here.
  if (!igt) return { projectId: currentProjectId, resources, failures, alreadyInitialized: false };

  // Step 9: Configure document metadata
  updateProgress(80, 'Configuring document metadata…');
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

  // Step 9b: the layer rules (domain/igtConstraints.js) on the layers this
  // setup found: one annotation per token in each field, one vocabulary link
  // per word and morpheme, morphemes as wide as their word, a closed tagset's
  // list. The layers it made hold theirs from the batch that made them, so
  // nothing is written for those here. A layer it adopted may hold data a
  // rule forbids: the server repairs what it can first, and a rule the data
  // still breaks (an off-list value) is left out, which is not a failed step.
  // Nothing declares it later on its own.
  updateProgress(85, 'Setting up annotation rules…');
  try {
    // A resumed native import holds the archive's data as it was: nothing is
    // repaired (importFinish.js `importRepairs`).
    const repair = importRepairs((await client.projects.get(currentProjectId))?.config);
    const rules = await declareIgtRules(client, currentProjectId, { repair });
    if (rules.notInForce.length) console.warn('Annotation rules not in force:', rules.notInForce);
  } catch (rulesError) {
    console.warn('Failed to set up the annotation rules:', rulesError);
    failures.push(`The annotation rules could not be set up: ${rulesError.message}`);
  }

  // Step 10: Mark initialized — ONLY if every step succeeded.
  if (failures.length === 0) {
    updateProgress(90, 'Finalizing setup…');
    await client.projects.setConfig(currentProjectId, IGT_NAMESPACE, 'initialized', true);
  }

  return { projectId: currentProjectId, resources, failures, alreadyInitialized: false };
}
