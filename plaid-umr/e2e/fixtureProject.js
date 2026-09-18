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
import { getUmrLayerInfo, missingUmrLayerLabels } from '../src/utils/umrLayerUtils.js';
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
