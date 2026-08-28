// Idempotent UD fixture builder: a project with the full layer configuration
// plus one document with a text body. Reuses by name on subsequent runs so the
// harness is fast and your dev DB grows a known-good fixture you can also poke
// at by hand.
//
// The layer configuration comes from `createUdProject` — the SAME function the
// New Project modal calls. This file used to build the layers itself, and that
// copy silently rotted: the substrate moved from `config.ud.*` flags to shared
// `config.plaid.role` tags and the copy kept writing the old flags, so every
// project it built read as completely unconfigured. Never re-inline it.

import PlaidClient from '@larc-iu/plaid-client';
import { createUdProject } from '../src/domain/udProjectSetup.js';
import { getUdLayerInfo, missingUdLayerLabels } from '../src/utils/udLayerUtils.js';
import { readToken } from './fixtures.js';

const PROJECT_NAME = 'E2E UD Fixture';
const DOC_NAME = 'Doc 1';
const SAMPLE_TEXT =
  'The quick brown fox jumps over the lazy dog. She sells sea shells by the sea shore.';

const BASE_URL = 'http://localhost:8085';

async function findProjectByName(client, name) {
  const projects = await client.projects.list();
  return projects.find((p) => p.name === name) || null;
}

async function ensureFixture() {
  const { token } = readToken();
  const client = new PlaidClient(BASE_URL, token);

  // 1. Project + layers. A project by this name is reused only if it is still
  // fully configured; a stale one is reported rather than patched. Healing an
  // old shape in place would mean carrying a second definition of the layout,
  // which is the exact thing that rotted here before.
  let project = await findProjectByName(client, PROJECT_NAME);
  if (project) {
    project = await client.projects.get(project.id);
    const info = getUdLayerInfo(project);
    if (!info.isConfigured) {
      throw new Error(
        `Project "${PROJECT_NAME}" (${project.id}) exists but is missing: ` +
          `${missingUdLayerLabels(info.missingLayers).join(', ')}. ` +
          `Delete it and re-run to rebuild the fixture from scratch.`,
      );
    }
  } else {
    const created = await createUdProject(client, PROJECT_NAME);
    project = await client.projects.get(created.id);
  }
  const projectId = project.id;
  const { textLayer } = getUdLayerInfo(project);

  // 2. Document. Reuse by name. If we create it, also seed a text body.
  const docs = await client.projects.listDocuments(projectId);
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
  ensureFixture()
    .then((f) => {
      console.log(JSON.stringify(f, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
