/**
 * The canonical UMR project bootstrap: create a project and every layer the
 * app requires, wired the way `getUmrLayerInfo` expects to find them. One
 * definition for the New Project dialog and the e2e fixture builder, so the
 * two cannot drift (plaid-ud learned that the hard way).
 *
 *   Text                      text layer,  role `baseline`
 *   ├─ Sentences              token layer, role `sentence`, partitioning
 *   │  └─ Words               token layer, role `word`,     non-overlapping
 *   └─ UMR nodes              token layer, ROOT, any, `umr.nodes`
 *      └─ UMR concepts        span layer, `umr.concepts`
 *         ├─ UMR relations        relation layer, `umr.relations`
 *         └─ UMR document graph   relation layer, `umr.documentGraph`
 *
 * No morpheme layer: that is IGT's, and this app reads it when a project has
 * one. Text and tokens are edited in IGT or UD, never here.
 */

import {
  PLAID_NAMESPACE,
  PRESERVE_ON_SPLIT_KEY,
  PROVENANCE_KEYS,
  ROLE_KEY,
  ROLES,
} from '@larc-iu/plaid-client';
import { UMR_NAMESPACE, UMR_LAYER_FLAGS } from '../utils/umrLayerUtils.js';

// Provenance survives a split made by any app on this substrate. See the
// manual's "Metadata Preserved Across a Split".
const declarePreserveOnSplit = (batch, layerId) =>
  batch.tokenLayers.setConfig(layerId, PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY, [
    ...PROVENANCE_KEYS,
  ]);

// Layer names as the layer list shows them.
const LAYER_NAMES = {
  text: 'Text',
  sentences: 'Sentences',
  words: 'Words',
  nodes: 'UMR nodes',
  concepts: 'UMR concepts',
  relations: 'UMR relations',
  documentGraph: 'UMR document graph',
};

// Bootstrap as a sequence of atomic batches: an op cannot reference an id
// produced earlier in the same batch, so each layer's setConfig and its child
// create move to the next batch. Each batch ends with the ONE create whose id
// the next batch needs, read as the last result rather than by position.
const bootstrap = async (client, projectName) => {
  const project = await client.projects.create(projectName);
  const projectId = project.id;
  try {
    const b2 = await client.batched(async (b) => {
      b.textLayers.create(projectId, LAYER_NAMES.text);
    });
    const textLayerId = b2.at(-1).body.id;

    const b3 = await client.batched(async (b) => {
      b.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
      b.tokenLayers.create(textLayerId, LAYER_NAMES.sentences, 'partitioning');
    });
    const sentenceLayerId = b3.at(-1).body.id;

    const b4 = await client.batched(async (b) => {
      b.tokenLayers.setConfig(sentenceLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SENTENCE);
      declarePreserveOnSplit(b, sentenceLayerId);
      b.tokenLayers.create(textLayerId, LAYER_NAMES.words, 'non-overlapping', sentenceLayerId);
    });
    const wordLayerId = b4.at(-1).body.id;

    // The node layer is a ROOT layer (no parent): see umrLayerUtils.js.
    const b5 = await client.batched(async (b) => {
      b.tokenLayers.setConfig(wordLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.WORD);
      declarePreserveOnSplit(b, wordLayerId);
      b.tokenLayers.create(textLayerId, LAYER_NAMES.nodes, 'any');
    });
    const nodeLayerId = b5.at(-1).body.id;

    const b6 = await client.batched(async (b) => {
      b.tokenLayers.setConfig(nodeLayerId, UMR_NAMESPACE, UMR_LAYER_FLAGS.nodes, true);
      b.spanLayers.create(nodeLayerId, LAYER_NAMES.concepts);
    });
    const conceptLayerId = b6.at(-1).body.id;

    const b7 = await client.batched(async (b) => {
      b.spanLayers.setConfig(conceptLayerId, UMR_NAMESPACE, UMR_LAYER_FLAGS.concepts, true);
      b.relationLayers.create(conceptLayerId, LAYER_NAMES.relations);
      b.relationLayers.create(conceptLayerId, LAYER_NAMES.documentGraph);
    });
    const [relationLayerId, documentGraphLayerId] = b7.slice(-2).map((r) => r.body.id);

    await client.batched(async (b) => {
      b.relationLayers.setConfig(relationLayerId, UMR_NAMESPACE, UMR_LAYER_FLAGS.relations, true);
      b.relationLayers.setConfig(
        documentGraphLayerId,
        UMR_NAMESPACE,
        UMR_LAYER_FLAGS.documentGraph,
        true,
      );
    });

    return project;
  } catch (err) {
    // Layers are immutable, so a half-configured project is rolled back by
    // deleting it. If that fails too, say so.
    try {
      await client.projects.delete(projectId);
    } catch (deleteErr) {
      const wrapped = new Error(
        `Project setup failed (${err?.message || 'Unknown error'}) and the rollback failed too ` +
          `(${deleteErr?.message || 'Unknown error'}). Delete project ${projectId} manually.`,
      );
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }
};

/**
 * Create a fully configured UMR project as one audited operation.
 * @param {object} client - PlaidClient instance
 * @param {string} projectName
 * @returns {Promise<object>} the created project
 */
export const createUmrProject = (client, projectName) =>
  client.withOperation(`Create UMR project "${projectName.trim()}"`, () =>
    bootstrap(client, projectName),
  );

/**
 * Add UMR's own layers to a project that already has a substrate (one set up
 * by IGT or UD). Creates only what is missing, so a re-run is harmless.
 * Sequential awaits on purpose: each step needs the id of the one before.
 * @param {object} client
 * @param {object} layerInfo - from getUmrLayerInfo on the project
 * @returns {Promise<boolean>} true when something was created
 */
export const adoptSubstrate = async (client, layerInfo) => {
  const { textLayer } = layerInfo;
  if (!textLayer) throw new Error('The project has no text layer to build on.');
  let created = false;
  return client.withOperation('Set the project up for UMR', async () => {
    let nodeLayerId = layerInfo.nodeTokenLayer?.id;
    if (!nodeLayerId) {
      const layer = await client.tokenLayers.create(textLayer.id, LAYER_NAMES.nodes, 'any');
      nodeLayerId = layer?.id || layer;
      await client.tokenLayers.setConfig(nodeLayerId, UMR_NAMESPACE, UMR_LAYER_FLAGS.nodes, true);
      created = true;
    }
    let conceptLayerId = layerInfo.conceptLayer?.id;
    if (!conceptLayerId) {
      const layer = await client.spanLayers.create(nodeLayerId, LAYER_NAMES.concepts);
      conceptLayerId = layer?.id || layer;
      await client.spanLayers.setConfig(
        conceptLayerId,
        UMR_NAMESPACE,
        UMR_LAYER_FLAGS.concepts,
        true,
      );
      created = true;
    }
    if (!layerInfo.relationLayer) {
      const layer = await client.relationLayers.create(conceptLayerId, LAYER_NAMES.relations);
      await client.relationLayers.setConfig(
        layer?.id || layer,
        UMR_NAMESPACE,
        UMR_LAYER_FLAGS.relations,
        true,
      );
      created = true;
    }
    if (!layerInfo.documentGraphLayer) {
      const layer = await client.relationLayers.create(conceptLayerId, LAYER_NAMES.documentGraph);
      await client.relationLayers.setConfig(
        layer?.id || layer,
        UMR_NAMESPACE,
        UMR_LAYER_FLAGS.documentGraph,
        true,
      );
      created = true;
    }
    return created;
  });
};
