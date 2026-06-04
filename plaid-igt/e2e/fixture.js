// Idempotent IGT fixture builder. Creates a Plaid-Base ("IGT") project with the
// full layer hierarchy the app expects (text > sentence/word/morpheme/alignment
// token layers + scoped span layers), the plaid.* config flags, and one document
// with a seeded text body. Reuses by name on subsequent runs.
//
// Recipe mirrors src/components/projects/setup/ConfirmationStep.jsx (the wizard's
// final step) — keep them in sync if the setup flow changes.
//
// Run standalone to print the IDs:  node e2e/fixture.js
import PlaidClient from '@larc-iu/plaid-client';
import { readToken } from './fixtures.js';

const CORE_URL = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const PROJECT_NAME = 'E2E IGT Fixture';
const DOC_NAME = 'Sample IGT Document';
const SAMPLE_TEXT = ' Todos los seres humanos nacen libres e iguales en dignidad y derechos.';
const VOCAB_NAME = 'IGT Lexicon';
const VOCAB_ITEMS = ['all', 'the', 'human', 'be.born', 'free', 'equal'];

function makeClient() {
  const { token } = readToken();
  return new PlaidClient(CORE_URL, token);
}

async function findProjectByName(client, name) {
  const projects = await client.projects.list();
  return projects.find((p) => p.name === name) || null;
}

async function ensureFixture() {
  const client = makeClient();

  // 1. Project (find-or-create)
  let project = await findProjectByName(client, PROJECT_NAME);
  let projectId;
  if (project) {
    projectId = project.id;
  } else {
    const created = await client.projects.create(PROJECT_NAME);
    projectId = created.id;
  }

  // If the project is already fully initialized, just make sure it has a
  // document and return — don't rebuild the (immutable) layer hierarchy.
  const full = await client.projects.get(projectId);
  if (full?.config?.plaid?.initialized === true) {
    await ensureVocab(client, projectId);
    return ensureDocument(client, projectId, full);
  }

  // 2. Text layer (primary)
  const textLayer = await client.textLayers.create(projectId, 'Main Text');
  await client.textLayers.setConfig(textLayer.id, 'plaid', 'primary', true);

  // 3. Token layers: sentence (partitioning root) > word (non-overlapping) >
  //    morpheme (any); plus an independent alignment layer (non-overlapping root).
  const sentenceLayer = await client.tokenLayers.create(textLayer.id, 'Sentences', 'partitioning');
  await client.tokenLayers.setConfig(sentenceLayer.id, 'plaid', 'sentence', true);

  const wordLayer = await client.tokenLayers.create(textLayer.id, 'Main Tokens', 'non-overlapping', sentenceLayer.id);
  await client.tokenLayers.setConfig(wordLayer.id, 'plaid', 'primary', true);

  const morphemeLayer = await client.tokenLayers.create(textLayer.id, 'Main Morphemes', 'any', wordLayer.id);
  await client.tokenLayers.setConfig(morphemeLayer.id, 'plaid', 'morpheme', true);

  const alignmentLayer = await client.tokenLayers.create(textLayer.id, 'Time Alignment', 'non-overlapping');
  await client.tokenLayers.setConfig(alignmentLayer.id, 'plaid', 'alignment', true);

  // 4. Orthographies on the word layer (baseline excluded)
  await client.tokenLayers.setConfig(wordLayer.id, 'plaid', 'orthographies', [{ name: 'IPA' }]);

  // 5. Span layers for a few annotation fields at each scope
  const fields = [
    { name: 'Gloss', scope: 'Morpheme', parent: morphemeLayer.id },
    { name: 'Part of Speech', scope: 'Word', parent: wordLayer.id },
    { name: 'Translation', scope: 'Sentence', parent: sentenceLayer.id },
  ];
  for (const f of fields) {
    const sl = await client.spanLayers.create(f.parent, f.name);
    await client.spanLayers.setConfig(sl.id, 'plaid', 'scope', f.scope);
  }

  // 6. Ignored tokens (unicode punctuation, no whitelist)
  await client.tokenLayers.setConfig(wordLayer.id, 'plaid', 'ignoredTokens', {
    type: 'unicodePunctuation',
    whitelist: [],
  });

  // 7. Document metadata fields
  await client.projects.setConfig(projectId, 'plaid', 'documentMetadata', [
    { name: 'Date' },
    { name: 'Speakers' },
  ]);

  // 8. Mark initialized
  await client.projects.setConfig(projectId, 'plaid', 'initialized', true);

  await ensureVocab(client, projectId);
  const finalProject = await client.projects.get(projectId);
  return ensureDocument(client, projectId, finalProject);
}

// Ensure a project-linked vocabulary with a few items exists, so the vocab-link
// popover has something to link against.
async function ensureVocab(client, projectId) {
  let vocab = (await client.vocabLayers.list()).find((v) => v.name === VOCAB_NAME);
  if (!vocab) {
    const created = await client.vocabLayers.create(VOCAB_NAME);
    vocab = { id: created.id, name: VOCAB_NAME };
    for (const form of VOCAB_ITEMS) await client.vocabItems.create(vocab.id, form);
  }
  const project = await client.projects.get(projectId);
  const linked = (project.vocabs || []).some((v) => v.id === vocab.id);
  if (!linked) await client.projects.linkVocab(projectId, vocab.id);
  return vocab.id;
}

function resolveLayers(project) {
  const tl = (project.textLayers || []).find((l) => l.config?.plaid?.primary) || (project.textLayers || [])[0];
  const tokenLayers = tl?.tokenLayers || [];
  return {
    textLayerId: tl?.id,
    sentenceLayerId: tokenLayers.find((l) => l.config?.plaid?.sentence)?.id,
    wordLayerId: tokenLayers.find((l) => l.config?.plaid?.primary)?.id,
    morphemeLayerId: tokenLayers.find((l) => l.config?.plaid?.morpheme)?.id,
  };
}

async function ensureDocument(client, projectId, project) {
  const layers = resolveLayers(project);
  const docs = await client.projects.listDocuments(projectId);
  let doc = docs.find((d) => d.name === DOC_NAME);
  if (!doc) {
    doc = await client.documents.create(projectId, DOC_NAME);
    if (layers.textLayerId) await client.texts.create(layers.textLayerId, doc.id, SAMPLE_TEXT);
  }
  await seedTokensIfEmpty(client, doc.id, layers);
  return { projectId, documentId: doc.id };
}

// Seed a sentence covering the whole body, one word token per whitespace-
// delimited run, and one morpheme per word (same extent, precedence 1) — so the
// Analyze interlinear grid has something to render. No-op if already tokenized.
async function seedTokensIfEmpty(client, documentId, layers) {
  const raw = await client.documents.get(documentId, true);
  const tl = (raw.textLayers || []).find((l) => l.config?.plaid?.primary);
  const text = tl?.text;
  if (!text?.body) return;
  const wordLayer = (tl.tokenLayers || []).find((l) => l.config?.plaid?.primary);
  if ((wordLayer?.tokens || []).length > 0) return; // already seeded
  const body = text.body;

  const sentLayer = (tl.tokenLayers || []).find((l) => l.config?.plaid?.sentence);
  if (layers.sentenceLayerId && (sentLayer?.tokens || []).length === 0) {
    await client.tokens.bulkCreate([{ tokenLayerId: layers.sentenceLayerId, text: text.id, begin: 0, end: body.length }]);
  }

  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(body)) !== null) words.push({ begin: m.index, end: m.index + m[0].length });

  if (layers.wordLayerId) {
    await client.tokens.bulkCreate(words.map((w) => ({ tokenLayerId: layers.wordLayerId, text: text.id, begin: w.begin, end: w.end })));
  }
  if (layers.morphemeLayerId) {
    await client.tokens.bulkCreate(words.map((w) => ({ tokenLayerId: layers.morphemeLayerId, text: text.id, begin: w.begin, end: w.end, precedence: 1 })));
  }
}

let cached = null;
export async function getFixture() {
  if (!cached) cached = ensureFixture();
  return cached;
}

// CLI mode: print IDs as JSON.
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureFixture()
    .then((ids) => {
      console.log(JSON.stringify(ids, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
