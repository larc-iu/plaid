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
 *            └─ Dependency Relations (on Lemma)         relation layer, `ud` flag
 *
 * Substrate layers (text + token) carry a shared ROLE so another Plaid app on
 * the same project resolves them identically. Annotation layers stay private
 * to UD under the `ud` namespace.
 */

import { PLAID_NAMESPACE, ROLE_KEY, ROLES } from '@larc-iu/plaid-client';
import {
  UD_NAMESPACE,
  UD_SPAN_CONFIG_KEYS,
  UD_RELATION_CONFIG_KEY,
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
    // B2: textLayer (alone; setConfig + sentence create both need its id)
    const b2 = await client.batched(async () => {
      client.textLayers.create(projectId, 'Text');
    });
    const textLayerId = b2[0].body.id;

    // B3: textLayer.setConfig + sentenceLayer.create
    const b3 = await client.batched(async () => {
      client.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
      client.tokenLayers.create(textLayerId, 'Sentences', 'partitioning');
    });
    const sentenceLayerId = b3[1].body.id;

    // B4: sentenceLayer.setConfig + wordLayer.create
    const b4 = await client.batched(async () => {
      client.tokenLayers.setConfig(sentenceLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SENTENCE);
      client.tokenLayers.create(textLayerId, 'Tokens', 'non-overlapping', sentenceLayerId);
    });
    const wordLayerId = b4[1].body.id;

    // B5: wordLayer.setConfig + morphemeLayer.create
    const b5 = await client.batched(async () => {
      client.tokenLayers.setConfig(wordLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.WORD);
      client.tokenLayers.create(textLayerId, 'Words', 'any', wordLayerId);
    });
    const morphemeLayerId = b5[1].body.id;

    // B6: morphemeLayer.setConfig + all 5 span layer creates
    const b6 = await client.batched(async () => {
      // UD's "Words" layer holds SYNTACTIC WORDS (MWT splits), so its role is
      // `syntactic-word`, NOT `morpheme`. IGT's true-morpheme layer is a
      // sibling under the shared word layer. Getting this wrong corrupts
      // segmentation.
      client.tokenLayers.setConfig(
        morphemeLayerId,
        PLAID_NAMESPACE,
        ROLE_KEY,
        ROLES.SYNTACTIC_WORD,
      );
      for (const [name] of SPAN_LAYER_SPECS) {
        client.spanLayers.create(morphemeLayerId, name);
      }
    });
    // b6: [setConfig, span0, span1, span2, span3, span4]
    const spanLayerIds = SPAN_LAYER_SPECS.map((_, i) => b6[1 + i].body.id);
    const lemmaIdx = SPAN_LAYER_SPECS.findIndex(([, key]) => key === UD_SPAN_CONFIG_KEYS.lemma);
    const lemmaLayerId = spanLayerIds[lemmaIdx];

    // B7: 5x spanLayer.setConfig + relationLayer.create (uses lemmaLayerId)
    const b7 = await client.batched(async () => {
      SPAN_LAYER_SPECS.forEach(([, configKey], i) => {
        client.spanLayers.setConfig(spanLayerIds[i], UD_NAMESPACE, configKey, true);
      });
      client.relationLayers.create(lemmaLayerId, 'Dependency Relations');
    });
    const relationLayerId = b7[b7.length - 1].body.id;

    // B8: relationLayer.setConfig
    await client.batched(async () => {
      client.relationLayers.setConfig(relationLayerId, UD_NAMESPACE, UD_RELATION_CONFIG_KEY, true);
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
        `Project bootstrap failed (${original}) AND rollback also failed (${dErr}). ` +
          `Please manually delete project ${projectId}.`,
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
