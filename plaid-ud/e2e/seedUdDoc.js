// Seed a throwaway UD project with one tokenized document, for the specs that
// need annotated words to act on.
//
// The layers come from `createUdProject`, the SAME function the New Project
// modal calls. Two specs had each built the three token layers, five span
// layers and the relation layer by hand, which is the copy that silently rotted
// once already (see the header of src/domain/udProjectSetup.js): the substrate
// moved to `config.plaid.role` tags and the hand copies kept writing the old
// `config.ud.*` flags, so every project they built read as unconfigured.
//
// Returns the ids a spec needs to seed annotations and open the editor.

import PlaidClient from '@larc-iu/plaid-client';
import { createUdProject } from '../src/domain/udProjectSetup.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';
import { readToken } from './fixtures.js';

const CORE = 'http://localhost:8085';

/**
 * @param {string} name        project name (make it unique per run)
 * @param {string} body        the document's text
 * @param {[number, number][]} words  word spans as [begin, end] code-point pairs
 * @param {[number, number][]} [sentences]  sentence spans, tiling the body.
 *   Defaults to one sentence over the whole thing, which is what every spec
 *   but the pager's wants.
 */
export async function seedUdDoc(name, body, words, sentences) {
  const { token } = readToken();
  const client = new PlaidClient(CORE, token);

  const created = await createUdProject(client, name);
  const project = await client.projects.get(created.id);
  const info = getUdLayerInfo(project);

  const doc = await client.documents.create(project.id, 'Doc');
  const text = await client.texts.create(info.textLayer.id, doc.id, body);

  const results = await client.batched(async (b) => {
    b.tokens.bulkCreate(
      (sentences || [[0, body.length]]).map(([begin, end]) => ({
        tokenLayerId: info.sentenceTokenLayer.id,
        text: text.id,
        begin,
        end,
      })),
    );
    b.tokens.bulkCreate(
      words.map(([begin, end]) => ({
        tokenLayerId: info.wordTokenLayer.id,
        text: text.id,
        begin,
        end,
      })),
    );
    b.tokens.bulkCreate(
      words.map(([begin, end]) => ({
        tokenLayerId: info.morphemeTokenLayer.id,
        text: text.id,
        begin,
        end,
        precedence: 0,
      })),
    );
  });
  const sentenceIds = results[0].body.ids;
  const morphIds = results[2].body.ids;

  return {
    client,
    sentenceIds,
    projectId: project.id,
    documentId: doc.id,
    morphIds,
    layers: {
      form: info.formLayer.id,
      lemma: info.lemmaLayer.id,
      upos: info.uposLayer.id,
      xpos: info.xposLayer.id,
      features: info.featuresLayer.id,
      relation: info.relationLayer.id,
    },
  };
}

/**
 * A UD project made as the New Project modal makes it (`createUdProject`), for
 * a spec that seeds its own document: the project and the ids of its layers.
 * A spec that built the layers by hand made a project UD reads as not set up
 * the day UD's set-up changed (the enhanced relation layer).
 *
 * @param {object} client - a PlaidClient
 * @param {string} name - project name (make it unique per run)
 */
export async function createUdLayers(client, name) {
  const created = await createUdProject(client, name);
  const info = getUdLayerInfo(await client.projects.get(created.id));
  return {
    projectId: created.id,
    textLayerId: info.textLayer.id,
    sentenceLayerId: info.sentenceTokenLayer.id,
    wordLayerId: info.wordTokenLayer.id,
    morphemeLayerId: info.morphemeTokenLayer.id,
    byKey: {
      form: info.formLayer.id,
      lemma: info.lemmaLayer.id,
      upos: info.uposLayer.id,
      xpos: info.xposLayer.id,
      features: info.featuresLayer.id,
    },
    relationLayerId: info.relationLayer.id,
    enhancedLayerId: info.enhancedRelationLayer.id,
  };
}
