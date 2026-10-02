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
  SPLIT_ON_SPACE_KEY,
  PROVENANCE_KEYS,
  ROLE_KEY,
  ROLES,
  findByRole,
  readRole,
  uuidv7,
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
  getUdLayerInfo,
} from '../utils/udLayerUtils.js';
import { queueDeclarations, wantedConstraints } from '../utils/udConstraints.js';
import { ensureLayerConstraints } from '../../../plaid-ui/src/lib/layerConstraints.js';

// A space typed inside a word splits it (see the manual's "Changing a text's
// body").
const declareSplitOnSpace = (target, layerId) => {
  target.tokenLayers.setConfig(layerId, PLAID_NAMESPACE, SPLIT_ON_SPACE_KEY, true);
};

export const SPAN_LAYER_SPECS = [
  ['Form', UD_SPAN_CONFIG_KEYS.form],
  ['Lemma', UD_SPAN_CONFIG_KEYS.lemma],
  ['UPOS', UD_SPAN_CONFIG_KEYS.upos],
  ['XPOS', UD_SPAN_CONFIG_KEYS.xpos],
  ['Features', UD_SPAN_CONFIG_KEYS.features],
];

// Bootstrap: the project, then every layer, its config and UD's layer rules
// in ONE atomic batch. Each layer is made under an id minted here, so a later
// op in the batch names it directly. A failed batch leaves an empty project,
// which the catch handler deletes.
const bootstrap = async (client, projectName) => {
  const project = await client.projects.create(projectName);
  const projectId = project.id;

  try {
    const textLayerId = uuidv7();
    const sentenceLayerId = uuidv7();
    const wordLayerId = uuidv7();
    const morphemeLayerId = uuidv7();
    const spanLayerIds = SPAN_LAYER_SPECS.map(() => uuidv7());
    const relationLayerId = uuidv7();
    const enhancedLayerId = uuidv7();
    const lemmaLayerId =
      spanLayerIds[SPAN_LAYER_SPECS.findIndex(([, key]) => key === UD_SPAN_CONFIG_KEYS.lemma)];
    const spanId = (key) => ({
      id: spanLayerIds[SPAN_LAYER_SPECS.findIndex(([, k]) => k === key)],
    });
    // UD's layer rules (see utils/udConstraints.js), in force before anything
    // is written.
    const rules = wantedConstraints({
      sentenceTokenLayer: { id: sentenceLayerId },
      wordTokenLayer: { id: wordLayerId },
      morphemeTokenLayer: { id: morphemeLayerId },
      formLayer: spanId(UD_SPAN_CONFIG_KEYS.form),
      lemmaLayer: spanId(UD_SPAN_CONFIG_KEYS.lemma),
      uposLayer: spanId(UD_SPAN_CONFIG_KEYS.upos),
      xposLayer: spanId(UD_SPAN_CONFIG_KEYS.xpos),
      relationLayer: { id: relationLayerId },
      enhancedRelationLayer: { id: enhancedLayerId },
    });
    await client.batched(async (b) => {
      b.textLayers.create(projectId, 'Text', undefined, { id: textLayerId });
      b.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);

      b.tokenLayers.create(textLayerId, 'Sentences', 'partitioning', undefined, undefined, {
        id: sentenceLayerId,
      });
      b.tokenLayers.setConfig(sentenceLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SENTENCE);
      declarePreserveOnSplit(b, sentenceLayerId);

      b.tokenLayers.create(textLayerId, 'Tokens', 'non-overlapping', sentenceLayerId, undefined, {
        id: wordLayerId,
      });
      b.tokenLayers.setConfig(wordLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.WORD);
      declarePreserveOnSplit(b, wordLayerId);
      declareSplitOnSpace(b, wordLayerId);

      // UD's "Words" layer holds SYNTACTIC WORDS (MWT splits), so its role is
      // `syntactic-word`, NOT `morpheme`. IGT's true-morpheme layer is a
      // sibling under the shared word layer. Getting this wrong corrupts
      // segmentation.
      b.tokenLayers.create(textLayerId, 'Words', 'any', wordLayerId, undefined, {
        id: morphemeLayerId,
      });
      b.tokenLayers.setConfig(morphemeLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.SYNTACTIC_WORD);
      declarePreserveOnSplit(b, morphemeLayerId);

      SPAN_LAYER_SPECS.forEach(([name, configKey], i) => {
        b.spanLayers.create(morphemeLayerId, name, undefined, { id: spanLayerIds[i] });
        b.spanLayers.setConfig(spanLayerIds[i], UD_NAMESPACE, configKey, true);
      });

      b.relationLayers.create(lemmaLayerId, 'Dependency Relations', undefined, {
        id: relationLayerId,
      });
      b.relationLayers.setConfig(relationLayerId, UD_NAMESPACE, UD_RELATION_CONFIG_KEY, true);
      b.relationLayers.create(lemmaLayerId, 'Enhanced Dependencies', undefined, {
        id: enhancedLayerId,
      });
      b.relationLayers.setConfig(
        enhancedLayerId,
        UD_NAMESPACE,
        UD_ENHANCED_RELATION_CONFIG_KEY,
        true,
      );
      queueDeclarations(b, rules);
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
      console.error('Setup failed:', original, 'Delete failed:', dErr);
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
 * missing. Every layer it makes is made under an id minted here, so the whole
 * set-up is one batch: it lands whole or not at all, and a layer is never left
 * without the flag or role a re-run would find it by.
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

    await client.batched(async (b) => {
      let textLayerId = existingTextLayer?.id;
      if (!textLayerId) {
        textLayerId = uuidv7();
        b.textLayers.create(project.id, 'Text', undefined, { id: textLayerId });
      }
      if (readRole(existingTextLayer?.config) !== ROLES.BASELINE) {
        b.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
      }

      // Sentences > Tokens > Words, bound by shared role. UD's "Words" layer
      // holds SYNTACTIC WORDS (CoNLL-U words / MWT splits), so its role is
      // `syntactic-word`: a sibling of IGT's `morpheme` layer under the shared
      // word layer, never the same layer.
      const ensureTokenLayer = (role, name, overlapMode, parentId) => {
        const existing = findByRole(existingTextLayer?.tokenLayers, role);
        if (existing) return existing.id;
        const id = uuidv7();
        b.tokenLayers.create(textLayerId, name, overlapMode, parentId, undefined, { id });
        b.tokenLayers.setConfig(id, PLAID_NAMESPACE, ROLE_KEY, role);
        declarePreserveOnSplit(b, id);
        return id;
      };
      const sentenceLayerId = ensureTokenLayer(ROLES.SENTENCE, 'Sentences', 'partitioning');
      const wordLayerId = ensureTokenLayer(
        ROLES.WORD,
        'Tokens',
        'non-overlapping',
        sentenceLayerId,
      );
      // On a project another app made, the word layer is shared, and a space
      // typed inside one of its words then splits it for both.
      const wordLayer = findByRole(existingTextLayer?.tokenLayers, ROLES.WORD);
      if (wordLayer?.config?.[PLAID_NAMESPACE]?.[SPLIT_ON_SPACE_KEY] !== true) {
        declareSplitOnSpace(b, wordLayerId);
      }
      const morphemeLayerId = ensureTokenLayer(ROLES.SYNTACTIC_WORD, 'Words', 'any', wordLayerId);

      // Annotation layers are UD's own, found by UD's flags under the layer UD
      // annotates: the one that was already there, or none when this call
      // makes it.
      const existingMorphemeLayer = findByRole(
        existingTextLayer?.tokenLayers,
        ROLES.SYNTACTIC_WORD,
      );
      const findFlagged = (layers, key) =>
        (layers || []).find((layer) => layer.config?.[UD_NAMESPACE]?.[key] === true) || null;

      let lemmaLayer = null;
      let lemmaLayerId = null;
      for (const [name, configKey] of SPAN_LAYER_SPECS) {
        const existing = findFlagged(existingMorphemeLayer?.spanLayers, configKey);
        let id = existing?.id;
        if (!id) {
          id = uuidv7();
          b.spanLayers.create(morphemeLayerId, name, undefined, { id });
          b.spanLayers.setConfig(id, UD_NAMESPACE, configKey, true);
        }
        if (configKey === UD_SPAN_CONFIG_KEYS.lemma) {
          lemmaLayer = existing;
          lemmaLayerId = id;
        }
      }

      // The dependency tree, and the enhanced graph beside it. `lemmaLayer` is
      // the project's own layer where it had one, relation layers and all, and
      // null where this call makes it, which has none to find.
      if (!findFlagged(lemmaLayer?.relationLayers, UD_RELATION_CONFIG_KEY)) {
        const id = uuidv7();
        b.relationLayers.create(lemmaLayerId, 'Dependency Relations', undefined, { id });
        b.relationLayers.setConfig(id, UD_NAMESPACE, UD_RELATION_CONFIG_KEY, true);
      }
      if (!findFlagged(lemmaLayer?.relationLayers, UD_ENHANCED_RELATION_CONFIG_KEY)) {
        queueEnhancedRelationLayer(b, lemmaLayerId);
      }
    });

    // UD's layer rules (utils/udConstraints.js). The layers adopted may hold
    // another app's data, which the server repairs first where a rule has a
    // repair. A rule the data still breaks is left for a maintainer's open
    // to report.
    const info = getUdLayerInfo(await client.projects.get(project.id));
    await ensureLayerConstraints(client, wantedConstraints(info), { canManage: true });
  });

// Queue on batch `b` the enhanced relation layer on the Lemma layer
// `lemmaLayerId`, made under an id minted here so its flag can name it.
// Answers that id.
const queueEnhancedRelationLayer = (b, lemmaLayerId) => {
  const id = uuidv7();
  b.relationLayers.create(lemmaLayerId, 'Enhanced Dependencies', undefined, { id });
  b.relationLayers.setConfig(id, UD_NAMESPACE, UD_ENHANCED_RELATION_CONFIG_KEY, true);
  return id;
};
