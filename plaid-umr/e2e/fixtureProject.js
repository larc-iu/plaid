// Idempotent UMR fixture builder: a project with the full layer configuration
// plus the English sample corpus imported as one document. Reuses by name on
// subsequent runs, so the dev DB grows a known-good fixture you can also poke
// at by hand.
//
// The layer configuration comes from `createUmrProject` and the document from
// `importUmrDocument`, the SAME functions the app calls. Never re-inline
// either: plaid-ud's fixture once carried its own copy of the layer setup and
// it rotted silently.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PlaidClient from '@larc-iu/plaid-client';
import { createUmrProject } from '../src/domain/umrProjectSetup.js';
import { importUmrDocument } from '../src/domain/umrImport.js';
import {
  getUmrLayerInfo,
  missingUmrLayerLabels,
  readProjectLanguage,
  UMR_NAMESPACE,
} from '../src/utils/umrLayerUtils.js';
import { readToken } from './fixtures.js';

const PROJECT_NAME = 'E2E UMR Fixture';
const DOC_NAME = 'english_umr-0001';
const SAMPLE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'umr',
  'english_umr-0001.umr',
);

const BASE_URL = 'http://localhost:8085';

async function findProjectByName(client, name) {
  const projects = await client.projects.list();
  return projects.find((p) => p.name === name) || null;
}

async function ensureFixture() {
  const { token } = readToken();
  const client = new PlaidClient(BASE_URL, token);

  let project = await findProjectByName(client, PROJECT_NAME);
  if (project) {
    project = await client.projects.get(project.id);
    const info = getUmrLayerInfo(project);
    if (!info.isConfigured) {
      throw new Error(
        `Project "${PROJECT_NAME}" (${project.id}) exists but is missing: ` +
          `${missingUmrLayerLabels(info.missingLayers).join(', ')}. ` +
          `Delete it and re-run to rebuild the fixture from scratch.`,
      );
    }
  } else {
    const created = await createUmrProject(client, PROJECT_NAME);
    project = await client.projects.get(created.id);
  }
  const projectId = project.id;

  // English, so the concept picker has a frame file to offer senses from.
  if (readProjectLanguage(project) !== 'en') {
    await client.projects.setConfig(projectId, UMR_NAMESPACE, 'language', 'en');
  }

  const docs = await client.projects.listDocuments(projectId);
  let doc = docs.find((d) => d.name === DOC_NAME) || null;
  let warnings = [];
  if (!doc) {
    const text = fs.readFileSync(SAMPLE, 'utf8');
    const result = await importUmrDocument(
      client,
      projectId,
      DOC_NAME,
      text,
      getUmrLayerInfo(project),
    );
    doc = result.document;
    warnings = result.warnings;
  }

  return { projectId, documentId: doc.id, warnings };
}

// A second fixture, glossed the way IGT lays a project out: a morpheme layer
// under Words, a Morpheme-scoped Gloss and a Sentence-scoped Translation
// (IGT's `config.igt.scope`), with one sentence's morphemes and glosses
// filled in. What the token row and an export read through the gloss-line
// mapping.
const GLOSSED_NAME = 'E2E UMR Glossed';
const GLOSSED_DOC = 'glossed';
const GLOSSED_FILE = `################################################################################
# :: snt1	Lindsay left in order to eat lunch .
Index: 1 2 3 4 5 6 7 8
Words: Lindsay left in order to eat lunch .

# sentence level graph:
(s1l / leave-02
    :ARG0 (s1p / person
        :name (s1n / name :op1 "Lindsay"))
    :aspect performance
    :purpose (s1e / eat-01 :ARG0 s1p :aspect performance))

# alignment:
s1l: 2-2
s1p: 1-1
s1n: 0-0
s1e: 6-6

# document level annotation:


`;

async function ensureGlossedFixture() {
  const { token } = readToken();
  const client = new PlaidClient(BASE_URL, token);
  let project = await findProjectByName(client, GLOSSED_NAME);
  if (!project) {
    const created = await createUmrProject(client, GLOSSED_NAME);
    project = await client.projects.get(created.id);
    const info = getUmrLayerInfo(project);
    const morphemes = await client.tokenLayers.create(
      info.textLayer.id,
      'Morphemes',
      'any',
      info.wordTokenLayer.id,
    );
    const morphemeId = morphemes?.id || morphemes;
    await client.tokenLayers.setConfig(morphemeId, 'plaid', 'role', 'morpheme');
    const gloss = await client.spanLayers.create(morphemeId, 'Gloss');
    await client.spanLayers.setConfig(gloss?.id || gloss, 'igt', 'scope', 'Morpheme');
    await client.spanLayers.setConfig(gloss?.id || gloss, 'igt', 'lang', 'en');
    const translation = await client.spanLayers.create(info.sentenceTokenLayer.id, 'Translation');
    await client.spanLayers.setConfig(translation?.id || translation, 'igt', 'scope', 'Sentence');
    await client.spanLayers.setConfig(translation?.id || translation, 'igt', 'lang', 'en');
    project = await client.projects.get(project.id);
  }
  const projectId = project.id;
  const info = getUmrLayerInfo(project);
  const docs = await client.projects.listDocuments(projectId);
  let doc = docs.find((d) => d.name === GLOSSED_DOC) || null;
  if (!doc) {
    const result = await importUmrDocument(client, projectId, GLOSSED_DOC, GLOSSED_FILE, info);
    doc = result.document;
  }
  // Sentence 1's morphemes and glosses, as an annotator in IGT would leave
  // them: "left" as lef-t, everything else one morpheme. Each step is skipped
  // when a previous run already did it, so a run that failed halfway heals.
  let raw = await client.documents.get(doc.id, true);
  let full = getUmrLayerInfo(raw);
  const textId = full.textLayer.text.id;
  const words = [...full.wordTokenLayer.tokens].sort((a, b) => a.begin - b.begin);
  const glosses = ['Lindsay', 'leave', 'PST', 'in', 'order', 'to', 'eat', 'lunch', '.'];
  if (!(full.morphemeTokenLayer.tokens || []).length) {
    const pieces = [];
    words.forEach((w, i) => {
      if (i === 1) {
        pieces.push({ begin: w.begin, end: w.begin + 3 }, { begin: w.begin + 3, end: w.end });
      } else {
        pieces.push({ begin: w.begin, end: w.end });
      }
    });
    await client.tokens.bulkCreate(
      pieces.map((pc) => ({ tokenLayerId: full.morphemeTokenLayer.id, text: textId, ...pc })),
    );
    raw = await client.documents.get(doc.id, true);
    full = getUmrLayerInfo(raw);
  }
  const morphemes = [...full.morphemeTokenLayer.tokens].sort((a, b) => a.begin - b.begin);
  const glossLayer = full.morphemeTokenLayer.spanLayers.find((l) => l.name === 'Gloss');
  const translationLayer = full.sentenceTokenLayer.spanLayers.find((l) => l.name === 'Translation');
  // One layer per bulk create: the server's rule.
  if (!(glossLayer.spans || []).length) {
    await client.spans.bulkCreate(
      morphemes.map((m, i) => ({ spanLayerId: glossLayer.id, tokens: [m.id], value: glosses[i] })),
    );
  }
  if (!(translationLayer.spans || []).length) {
    await client.spans.bulkCreate([
      {
        spanLayerId: translationLayer.id,
        tokens: [full.sentenceTokenLayer.tokens[0].id],
        value: 'Lindsay went off to have lunch.',
      },
    ]);
  }
  return { projectId, documentId: doc.id };
}

let cachedGlossed = null;
export async function getGlossedFixture() {
  if (!cachedGlossed) cachedGlossed = ensureGlossedFixture();
  return cachedGlossed;
}

let cached = null;
export async function getFixture() {
  if (!cached) cached = ensureFixture();
  return cached;
}

// CLI mode: `node e2e/fixtureProject.js` prints the IDs and exits.
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureFixture()
    .then((f) => {
      console.log(JSON.stringify(f, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
