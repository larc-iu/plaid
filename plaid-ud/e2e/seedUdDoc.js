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
 */
export async function seedUdDoc(name, body, words) {
  const { token } = readToken();
  const client = new PlaidClient(CORE, token);

  const created = await createUdProject(client, name);
  const project = await client.projects.get(created.id);
  const info = getUdLayerInfo(project);

  const doc = await client.documents.create(project.id, 'Doc');
  const text = await client.texts.create(info.textLayer.id, doc.id, body);

  client.beginBatch();
  client.tokens.bulkCreate([
    { tokenLayerId: info.sentenceTokenLayer.id, text: text.id, begin: 0, end: body.length },
  ]);
  client.tokens.bulkCreate(
    words.map(([begin, end]) => ({
      tokenLayerId: info.wordTokenLayer.id,
      text: text.id,
      begin,
      end,
    })),
  );
  client.tokens.bulkCreate(
    words.map(([begin, end]) => ({
      tokenLayerId: info.morphemeTokenLayer.id,
      text: text.id,
      begin,
      end,
      precedence: 0,
    })),
  );
  const morphIds = (await client.submitBatch())[2].body.ids;

  return {
    client,
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
