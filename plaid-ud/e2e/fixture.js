// Idempotent UD fixture builder. Creates a project + 3-layer token hierarchy
// (sentences:partitioning > words:non-overlapping > morphemes:any) with the
// five UD span layers + dependency relation layer + one document. Reuses by
// name on subsequent runs so the harness is fast and your dev DB grows a
// known-good fixture you can also poke at by hand.

import PlaidClient from 'plaid-client';
import { readToken } from './fixtures.js';

const NS = 'ud';
const PROJECT_NAME = 'E2E UD Fixture';
const TEXT_LAYER_NAME = 'Text';
const DOC_NAME = 'Doc 1';
const SAMPLE_TEXT =
  'The quick brown fox jumps over the lazy dog. She sells sea shells by the sea shore.';

const TOKEN_LAYER_PLAN = [
  { name: 'Sentences', configKey: 'sentenceTokenLayer', overlapMode: 'partitioning', parent: null },
  { name: 'Words',     configKey: 'wordTokenLayer',     overlapMode: 'non-overlapping', parent: 'Sentences' },
  { name: 'Morphemes', configKey: 'morphemeTokenLayer', overlapMode: 'any',              parent: 'Words' },
];
const SPAN_LAYER_PLAN = [
  { name: 'Form',     configKey: 'form' },
  { name: 'Lemma',    configKey: 'lemma' },
  { name: 'UPOS',     configKey: 'upos' },
  { name: 'XPOS',     configKey: 'xpos' },
  { name: 'Features', configKey: 'features' },
];

const BASE_URL = 'http://localhost:8085';

function flag(config, key) {
  return config?.[NS]?.[key] === true;
}

function findFlagged(layers, key) {
  return (layers || []).find((l) => flag(l.config, key)) || null;
}

async function findProjectByName(client, name) {
  const projects = await client.projects.list();
  return projects.find((p) => p.name === name) || null;
}

async function ensureFixture() {
  const { token } = readToken();
  const client = new PlaidClient(BASE_URL, token);

  // 1. Project
  let project = await findProjectByName(client, PROJECT_NAME);
  if (!project) {
    const created = await client.projects.create(PROJECT_NAME);
    project = await client.projects.get(created.id);
  } else {
    // Refetch to pick up any layers added on prior runs.
    project = await client.projects.get(project.id);
  }
  const projectId = project.id;

  // 2. Text layer
  let textLayer = (project.textLayers || []).find((l) => flag(l.config, 'textLayer'))
    || (project.textLayers || []).find((l) => l.name === TEXT_LAYER_NAME)
    || null;
  if (!textLayer) {
    const created = await client.textLayers.create(projectId, TEXT_LAYER_NAME);
    await client.textLayers.setConfig(created.id, NS, 'textLayer', true);
    project = await client.projects.get(projectId);
    textLayer = project.textLayers.find((l) => l.id === created.id);
  } else if (!flag(textLayer.config, 'textLayer')) {
    await client.textLayers.setConfig(textLayer.id, NS, 'textLayer', true);
  }

  // 3. Token-layer hierarchy
  const tokenLayersByConfigKey = {};
  for (const step of TOKEN_LAYER_PLAN) {
    let layer = findFlagged(textLayer.tokenLayers, step.configKey);
    if (!layer) {
      const parentId = step.parent ? tokenLayersByConfigKey[
        TOKEN_LAYER_PLAN.find((s) => s.name === step.parent).configKey
      ].id : undefined;
      const created = await client.tokenLayers.create(textLayer.id, step.name, step.overlapMode, parentId);
      await client.tokenLayers.setConfig(created.id, NS, step.configKey, true);
      layer = { id: created.id, name: step.name, config: { [NS]: { [step.configKey]: true } } };
    }
    tokenLayersByConfigKey[step.configKey] = layer;
  }

  // Refetch text-layer to get the morpheme layer's full tree (span layers etc.)
  project = await client.projects.get(projectId);
  textLayer = project.textLayers.find((l) => l.id === textLayer.id);
  const morphemeLayer = findFlagged(textLayer.tokenLayers, 'morphemeTokenLayer');

  // 4. Span layers under morpheme
  const spanLayersByConfigKey = {};
  for (const step of SPAN_LAYER_PLAN) {
    let layer = findFlagged(morphemeLayer.spanLayers, step.configKey);
    if (!layer) {
      const created = await client.spanLayers.create(morphemeLayer.id, step.name);
      await client.spanLayers.setConfig(created.id, NS, step.configKey, true);
      layer = { id: created.id };
    }
    spanLayersByConfigKey[step.configKey] = layer;
  }

  // 5. Dependency relation layer hangs off Lemma
  project = await client.projects.get(projectId);
  textLayer = project.textLayers.find((l) => l.id === textLayer.id);
  const morphemeLayerFresh = findFlagged(textLayer.tokenLayers, 'morphemeTokenLayer');
  const lemmaLayer = findFlagged(morphemeLayerFresh.spanLayers, 'lemma');
  const existingRelLayer = findFlagged(lemmaLayer.relationLayers, 'dependency');
  if (!existingRelLayer) {
    const created = await client.relationLayers.create(lemmaLayer.id, 'Dependency Relations');
    await client.relationLayers.setConfig(created.id, NS, 'dependency', true);
  }

  // 6. Document. Reuse by name. If we create it, also seed a text body.
  const docs = await client.projects.get(projectId, true).then((p) => p.documents || []);
  let doc = docs.find((d) => d.name === DOC_NAME) || null;
  if (!doc) {
    const created = await client.documents.create(projectId, DOC_NAME);
    await client.texts.create(textLayer.id, created.id, SAMPLE_TEXT);
    doc = { id: created.id, name: DOC_NAME };
  }

  return { projectId, documentId: doc.id };
}

// Cache so multiple tests in one run don't repeat the work.
let cached = null;
export async function getFixture() {
  if (!cached) cached = ensureFixture();
  return cached;
}

// CLI mode: `node e2e/fixture.js` prints the IDs and exits.
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureFixture().then((f) => {
    console.log(JSON.stringify(f, null, 2));
    process.exit(0);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
