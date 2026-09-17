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
} from '@larc-iu/plaid-client';

// Provenance survives a split, including one made by another app sharing this
// substrate that has never heard of these keys. Declared on the layer because
// a token born of a split is otherwise born bare, and what is lost that way
// leaves nothing for a later reconcile to find. See the manual's "Metadata
// Preserved Across a Split".
// Takes the batch it queues on, since every caller writes inside one.
const declarePreserveOnSplit = (batch, layerId) =>
  batch.tokenLayers.setConfig(layerId, PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY, [
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
