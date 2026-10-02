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
  uuidv7,
} from '@larc-iu/plaid-client';
import { UMR_NAMESPACE, UMR_LAYER_FLAGS } from '../utils/umrLayerUtils.js';
import { relationRules } from './umrConstraints.js';

// Provenance survives a split made by any app on this substrate. See the
// manual's "Metadata Preserved Across a Split".
const declarePreserveOnSplit = (batch, layerId) =>
  batch.tokenLayers.setConfig(layerId, PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY, [
    ...PROVENANCE_KEYS,
  ]);

// A relation of the sentence graph stays inside its sentence (umrConstraints.js).
// The layer is new and empty, so the declaration cannot be refused.
const declareRelationRules = (batch, relationLayerId, sentenceLayerId) =>
  batch.relationLayers.setConstraints(
    relationLayerId,
    UMR_NAMESPACE,
    relationRules(sentenceLayerId),
    undefined,
    { expected: null },
  );

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

// Queue on batch `b` UMR's concept layer under the node layer and its two
// relation layers, each with its flag, those not there yet, every one made
// under an id minted here. Answers whether it queued any.
const queueUmrLayers = (
  b,
  { nodeLayerId, sentenceLayerId, conceptLayerId = null, hasRelations, hasDocumentGraph },
) => {
  let queued = false;
  let conceptId = conceptLayerId;
  if (!conceptId) {
    conceptId = uuidv7();
    b.spanLayers.create(nodeLayerId, LAYER_NAMES.concepts, undefined, { id: conceptId });
    b.spanLayers.setConfig(conceptId, UMR_NAMESPACE, UMR_LAYER_FLAGS.concepts, true);
    queued = true;
  }
  if (!hasRelations) {
    const id = uuidv7();
    b.relationLayers.create(conceptId, LAYER_NAMES.relations, undefined, { id });
    b.relationLayers.setConfig(id, UMR_NAMESPACE, UMR_LAYER_FLAGS.relations, true);
    if (sentenceLayerId) declareRelationRules(b, id, sentenceLayerId);
    queued = true;
  }
  if (!hasDocumentGraph) {
    const id = uuidv7();
    b.relationLayers.create(conceptId, LAYER_NAMES.documentGraph, undefined, { id });
    b.relationLayers.setConfig(id, UMR_NAMESPACE, UMR_LAYER_FLAGS.documentGraph, true);
    queued = true;
  }
  return queued;
};

// Bootstrap: the project, then every layer and its config in ONE atomic
// batch. Each layer is made under an id minted here, so a later op in the
// batch names it directly. A failed batch leaves an empty project, which the
// catch handler deletes.
const bootstrap = async (client, projectName) => {
  const project = await client.projects.create(projectName);
  const projectId = project.id;
  try {
    const textLayerId = uuidv7();
    const sentenceLayerId = uuidv7();
    const wordLayerId = uuidv7();
    const nodeLayerId = uuidv7();
    await client.batched(async (b) => {
      b.textLayers.create(projectId, LAYER_NAMES.text, undefined, { id: textLayerId });
      b.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);

      b.tokenLayers.create(
        textLayerId,
        LAYER_NAMES.sentences,
        'partitioning',
        undefined,
        undefined,
        {
          id: sentenceLayerId,
        },
      );
      b.tokenLayers.setConfig(sentenceLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SENTENCE);
      declarePreserveOnSplit(b, sentenceLayerId);

      b.tokenLayers.create(
        textLayerId,
        LAYER_NAMES.words,
        'non-overlapping',
        sentenceLayerId,
        undefined,
        { id: wordLayerId },
      );
      b.tokenLayers.setConfig(wordLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.WORD);
      declarePreserveOnSplit(b, wordLayerId);

      // The node layer is a ROOT layer (no parent): see umrLayerUtils.js.
      b.tokenLayers.create(textLayerId, LAYER_NAMES.nodes, 'any', undefined, undefined, {
        id: nodeLayerId,
      });
      b.tokenLayers.setConfig(nodeLayerId, UMR_NAMESPACE, UMR_LAYER_FLAGS.nodes, true);

      queueUmrLayers(b, { nodeLayerId, sentenceLayerId });
    });

    return project;
  } catch (err) {
    // Layers are immutable, so a half-configured project is rolled back by
    // deleting it. If that fails too, say so.
    try {
      await client.projects.delete(projectId);
    } catch (deleteErr) {
      console.error('Setup failed:', err, 'Delete failed:', deleteErr);
      const wrapped = new Error(
        `Failed to set up the project, and the partial project was not deleted. Delete “${projectName.trim()}” by hand.`,
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
 * by IGT or UD). Creates only what is missing, so a re-run is harmless. One
 * batch, every new layer made under an id minted here: it lands whole or not
 * at all, so a layer is never left without the flag a re-run finds it by.
 * @param {object} client
 * @param {object} layerInfo - from getUmrLayerInfo on the project
 * @returns {Promise<boolean>} true when something was created
 */
export const adoptSubstrate = async (client, layerInfo) => {
  const { textLayer } = layerInfo;
  if (!textLayer) throw new Error('The project has no text layer to build on.');
  return client.withOperation('Set the project up for UMR', async () => {
    let created = false;
    await client.batched(async (b) => {
      let nodeLayerId = layerInfo.nodeTokenLayer?.id;
      if (!nodeLayerId) {
        nodeLayerId = uuidv7();
        b.tokenLayers.create(textLayer.id, LAYER_NAMES.nodes, 'any', undefined, undefined, {
          id: nodeLayerId,
        });
        b.tokenLayers.setConfig(nodeLayerId, UMR_NAMESPACE, UMR_LAYER_FLAGS.nodes, true);
        created = true;
      }
      created =
        queueUmrLayers(b, {
          nodeLayerId,
          sentenceLayerId: layerInfo.sentenceTokenLayer?.id,
          conceptLayerId: layerInfo.conceptLayer?.id,
          hasRelations: !!layerInfo.relationLayer,
          hasDocumentGraph: !!layerInfo.documentGraphLayer,
        }) || created;
    });
    return created;
  });
};
