/**
 * The canonical UD project bootstrap: create a project and every layer the
 * editor requires, wired the way `getUdLayerInfo` expects to find them.
 *
 * This lives apart from the UI because it has two callers — the New Project
 * modal and the e2e fixture builder — and when the fixture had its own copy it
 * silently drifted: the substrate moved from `config.ud.*` flags to shared
 * `config.plaid.role` tags and the copy did not follow, so every project the
 * fixture built read as unconfigured. One definition, no drift.
 *
 * The shape it creates:
 *
 *   Text                      text layer,  role `baseline`
 *   └─ Sentences              token layer, role `sentence`,        partitioning
 *      └─ Tokens              token layer, role `word`,            non-overlapping
 *         └─ Words            token layer, role `syntactic-word`,  any
 *            ├─ Form / Lemma / UPOS / XPOS / Features   span layers, `ud` flags
 *            ├─ Dependency Relations (on Lemma)         relation layer, `ud` flag
 *            └─ Enhanced Dependencies (on Lemma)        relation layer, `ud` flag
 *
 * Substrate layers (text + token) carry a shared ROLE so another Plaid app on
 * the same project resolves them identically. Annotation layers stay private
 * to UD under the `ud` namespace.
 */

import {
  PLAID_NAMESPACE,
  PRESERVE_ON_SPLIT_KEY,
  PROVENANCE_KEYS,
  ROLE_KEY,
  ROLES,
  findByRole,
  readRole,
} from '@larc-iu/plaid-client';

// Provenance survives a split, including one made by another app sharing this
// substrate that has never heard of these keys. Declared on the layer because
// a token born of a split is otherwise born bare, and what is lost that way
// leaves nothing for a later reconcile to find. See the manual's "Metadata
// Preserved Across a Split".
// Takes whatever it writes through: the batch the bootstrap queues on, or the
// client itself when `adoptSubstrate` writes one layer at a time.
const declarePreserveOnSplit = (target, layerId) =>
  target.tokenLayers.setConfig(layerId, PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY, [
    ...PROVENANCE_KEYS,
  ]);
import {
  UD_NAMESPACE,
  UD_SPAN_CONFIG_KEYS,
  UD_RELATION_CONFIG_KEY,
  UD_ENHANCED_RELATION_CONFIG_KEY,
} from '../utils/udLayerUtils.js';

export const SPAN_LAYER_SPECS = [
  ['Form', UD_SPAN_CONFIG_KEYS.form],
  ['Lemma', UD_SPAN_CONFIG_KEYS.lemma],
  ['UPOS', UD_SPAN_CONFIG_KEYS.upos],
  ['XPOS', UD_SPAN_CONFIG_KEYS.xpos],
  ['Features', UD_SPAN_CONFIG_KEYS.features],
];

// Bootstrap as a sequence of atomic batches. Each batch is server-side atomic
// (full rollback on any op failure), so a partial failure is limited to
// "batches 1..k-1 committed, batch k failed". The catch handler deletes the
// project to roll that prefix back, since layers are immutable and a
// half-configured project is otherwise permanently broken.
//
// Why so many batches: an op cannot reference an id produced earlier in the
// SAME batch. So each layer's setConfig (which needs the layer's id) and any
// child create (which needs the parent's id) must move to the next batch. We
// pair each setConfig with the next downstream create to minimize round-trips.
const bootstrap = async (client, projectName) => {
  // B1: project (alone; textLayer needs project.id)
  const project = await client.projects.create(projectName);
  const projectId = project.id;

  try {
    // Each batch ends with the ONE create whose id the next batch needs, and
    // that result is read as the last of the batch rather than by position.
    // Position broke once already: `declarePreserveOnSplit` was added to B4 and
    // B5 in 9d9608ef, which pushed each create from index 1 to index 2, and
    // creating a UD project failed on `null.id` from then on. Adding a config
    // op must not be able to do that again.
    // B2: textLayer (alone; setConfig + sentence create both need its id)
    const b2 = await client.batched(async (b) => {
      b.textLayers.create(projectId, 'Text');
    });
    const textLayerId = b2.at(-1).body.id;

    // B3: textLayer.setConfig + sentenceLayer.create
    const b3 = await client.batched(async (b) => {
      b.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
      b.tokenLayers.create(textLayerId, 'Sentences', 'partitioning');
    });
    const sentenceLayerId = b3.at(-1).body.id;

    // B4: sentenceLayer.setConfig + wordLayer.create
    const b4 = await client.batched(async (b) => {
      b.tokenLayers.setConfig(sentenceLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SENTENCE);
      declarePreserveOnSplit(b, sentenceLayerId);
      b.tokenLayers.create(textLayerId, 'Tokens', 'non-overlapping', sentenceLayerId);
    });
    const wordLayerId = b4.at(-1).body.id;

    // B5: wordLayer.setConfig + morphemeLayer.create
    const b5 = await client.batched(async (b) => {
      b.tokenLayers.setConfig(wordLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.WORD);
      declarePreserveOnSplit(b, wordLayerId);
      b.tokenLayers.create(textLayerId, 'Words', 'any', wordLayerId);
    });
    const morphemeLayerId = b5.at(-1).body.id;

    // B6: morphemeLayer.setConfig + all 5 span layer creates
    const b6 = await client.batched(async (b) => {
      // UD's "Words" layer holds SYNTACTIC WORDS (MWT splits), so its role is
      // `syntactic-word`, NOT `morpheme`. IGT's true-morpheme layer is a
      // sibling under the shared word layer. Getting this wrong corrupts
      // segmentation.
      b.tokenLayers.setConfig(morphemeLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SYNTACTIC_WORD);
      declarePreserveOnSplit(b, morphemeLayerId);
      for (const [name] of SPAN_LAYER_SPECS) {
        b.spanLayers.create(morphemeLayerId, name);
      }
    });
    // The five span creates are the LAST five results, whatever config ops run
    // before them (see the note on B2 above).
    const spanLayerIds = b6.slice(-SPAN_LAYER_SPECS.length).map((r) => r.body.id);
    const lemmaIdx = SPAN_LAYER_SPECS.findIndex(([, key]) => key === UD_SPAN_CONFIG_KEYS.lemma);
    const lemmaLayerId = spanLayerIds[lemmaIdx];

    // B7: 5x spanLayer.setConfig + both relationLayer creates (use lemmaLayerId)
    const b7 = await client.batched(async (b) => {
      SPAN_LAYER_SPECS.forEach(([, configKey], i) => {
        b.spanLayers.setConfig(spanLayerIds[i], UD_NAMESPACE, configKey, true);
      });
      b.relationLayers.create(lemmaLayerId, 'Dependency Relations');
      b.relationLayers.create(lemmaLayerId, 'Enhanced Dependencies');
    });
    // The two creates are the LAST two results (see the note on B2 above).
    const [relationLayerId, enhancedLayerId] = b7.slice(-2).map((r) => r.body.id);

    // B8: both relationLayer.setConfig
    await client.batched(async (b) => {
      b.relationLayers.setConfig(relationLayerId, UD_NAMESPACE, UD_RELATION_CONFIG_KEY, true);
      b.relationLayers.setConfig(
        enhancedLayerId,
        UD_NAMESPACE,
        UD_ENHANCED_RELATION_CONFIG_KEY,
        true,
      );
    });

    return project;
  } catch (err) {
    // Best-effort rollback: layers are immutable, so delete the half-created
    // project. If deletion fails too, surface that.
    try {
      await client.projects.delete(projectId);
    } catch (deleteErr) {
      console.error('Failed to roll back partially-created project:', deleteErr);
      const original = err?.message || 'Unknown error';
      const dErr = deleteErr?.message || 'Unknown error';
      const wrapped = new Error(
        `Project setup failed (${original}) and the rollback failed too (${dErr}). ` +
          `Delete project ${projectId} manually.`,
      );
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }
};

/**
 * Create a fully-configured UD project. The whole bootstrap (project + the
 * layer/config batches) is ONE logical operation in the audit log; a
 * best-effort rollback delete on failure lands under it too, which is the
 * honest reading.
 *
 * @param {object} client - PlaidClient instance
 * @param {string} projectName
 * @returns {Promise<object>} the created project
 */
export const createUdProject = (client, projectName) =>
  client.withOperation(`Create UD project "${projectName.trim()}"`, () =>
    bootstrap(client, projectName),
  );

/**
 * Add UD's layers to a project that is not set up for UD yet, reusing every
 * layer already there, including the ones another app set up. This is how a
 * project born in IGT or UMR becomes one UD can open.
 *
 * There is nothing to choose. The text layer is the one carrying the baseline
 * role, and a project made by any Plaid app has exactly one; failing that, the
 * project's only text layer, or a new one when it has none. Everything below
 * is found by role or by UD's own config flag, and created where it is
 * missing, so a re-run after a failure picks up where it left off.
 *
 * Sequential awaits, not a batch: each find-or-create needs the result of the
 * one before it, which is also what makes a re-run safe.
 *
 * @param {object} client - PlaidClient instance
 * @param {object} project - the project, as read
 * @returns {Promise<void>}
 */
export const adoptSubstrate = (client, project) =>
  client.withOperation('Set the project up for UD', async () => {
    const textLayers = project?.textLayers || [];
    const baseline = findByRole(textLayers, ROLES.BASELINE);
    // Two text layers with no baseline role between them is not a project any
    // Plaid app makes, and picking one for the writer would be a guess.
    if (!baseline && textLayers.length > 1) {
      throw new Error('This project has more than one text layer.');
    }
    const existingTextLayer = baseline || textLayers[0] || null;

    let textLayerId = existingTextLayer?.id;
    if (!textLayerId) {
      const created = await client.textLayers.create(project.id, 'Text');
      textLayerId = created?.id || created;
    }
    if (readRole(existingTextLayer?.config) !== ROLES.BASELINE) {
      await client.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
    }

    // Sentences > Tokens > Words, bound by shared role. UD's "Words" layer
    // holds SYNTACTIC WORDS (CoNLL-U words / MWT splits), so its role is
    // `syntactic-word`: a sibling of IGT's `morpheme` layer under the shared
    // word layer, never the same layer.
    const ensureTokenLayer = async (role, name, overlapMode, parentId) => {
      const existing = findByRole(existingTextLayer?.tokenLayers, role);
      if (existing) return existing.id;
      const created = await client.tokenLayers.create(textLayerId, name, overlapMode, parentId);
      const id = created?.id || created;
      await client.tokenLayers.setConfig(id, PLAID_NAMESPACE, ROLE_KEY, role);
      await declarePreserveOnSplit(client, id);
      return id;
    };
    const sentenceLayerId = await ensureTokenLayer(ROLES.SENTENCE, 'Sentences', 'partitioning');
    const wordLayerId = await ensureTokenLayer(
      ROLES.WORD,
      'Tokens',
      'non-overlapping',
      sentenceLayerId,
    );
    const morphemeLayerId = await ensureTokenLayer(
      ROLES.SYNTACTIC_WORD,
      'Words',
      'any',
      wordLayerId,
    );

    // Annotation layers are UD's own, found by UD's flags under the layer UD
    // annotates: the one that was already there, or none when this call just
    // made it.
    const existingMorphemeLayer = findByRole(existingTextLayer?.tokenLayers, ROLES.SYNTACTIC_WORD);
    const findFlagged = (layers, key) =>
      (layers || []).find((layer) => layer.config?.[UD_NAMESPACE]?.[key] === true) || null;

    let lemmaLayer = null;
    let lemmaLayerId = null;
    for (const [name, configKey] of SPAN_LAYER_SPECS) {
      const existing = findFlagged(existingMorphemeLayer?.spanLayers, configKey);
      let id = existing?.id;
      if (!id) {
        const created = await client.spanLayers.create(morphemeLayerId, name);
        id = created?.id || created;
        await client.spanLayers.setConfig(id, UD_NAMESPACE, configKey, true);
      }
      if (configKey === UD_SPAN_CONFIG_KEYS.lemma) {
        lemmaLayer = existing;
        lemmaLayerId = id;
      }
    }

    // The dependency tree, and the enhanced graph beside it. `lemmaLayer` is
    // the project's own layer where it had one, relation layers and all, and
    // null where this call just made it, which has none to find.
    if (!findFlagged(lemmaLayer?.relationLayers, UD_RELATION_CONFIG_KEY)) {
      const created = await client.relationLayers.create(lemmaLayerId, 'Dependency Relations');
      await client.relationLayers.setConfig(
        created?.id || created,
        UD_NAMESPACE,
        UD_RELATION_CONFIG_KEY,
        true,
      );
    }
    await ensureEnhancedRelationLayer(client, lemmaLayer || { id: lemmaLayerId });
  });

/**
 * The project's enhanced relation layer, made if it has none: a second
 * relation layer on Lemma, beside the tree's (see domain/enhancedGraph.js).
 *
 * Every new project is given one by the bootstrap above. This is for the
 * projects that were not: one made before the layer existed, or one another
 * app set up and UD adopted. A relation layer can be added to a project at any
 * time, so they take it as readily. It needs a maintainer, being a layer, so
 * the callers are the three places a maintainer is known to be standing: the
 * layer setup page, reconcile-on-open, and the bulk import. Two writes, since
 * the flag needs the layer's id.
 *
 * @param {object} client - PlaidClient instance
 * @param {object} lemmaLayer - the project's Lemma span layer, as read
 * @returns {Promise<string|null>} the id of a layer this call CREATED, or null
 *   when the project already had one
 */
export const ensureEnhancedRelationLayer = async (client, lemmaLayer) => {
  if (!lemmaLayer?.id) return null;
  const existing = (lemmaLayer.relationLayers || []).find(
    (layer) => layer.config?.[UD_NAMESPACE]?.[UD_ENHANCED_RELATION_CONFIG_KEY] === true,
  );
  if (existing) return null;
  return client.withOperation('Add the enhanced dependency layer', async () => {
    const created = await client.relationLayers.create(lemmaLayer.id, 'Enhanced Dependencies');
    const layerId = created?.id || created;
    await client.relationLayers.setConfig(
      layerId,
      UD_NAMESPACE,
      UD_ENHANCED_RELATION_CONFIG_KEY,
      true,
    );
    return layerId;
  });
};
