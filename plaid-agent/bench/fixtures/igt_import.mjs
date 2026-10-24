// Import a CLDF zip into a NEW igt project through plaid-igt's own setup
// executor and CLDF import engine, as the import wizard does. Run from
// plaid-igt/ (build.sh copies it to plaid-igt/out/bench/):
//
//   node --import ./e2e/live/aliases.mjs out/bench/igt_import.mjs CORE TOKEN ZIP NAME
//
// Prints one JSON line: {projectId, documents: [{id, name}], stats}.
import { readFileSync } from 'node:fs';
import PlaidClient from '@larc-iu/plaid-client';
import { readCldfDataset } from '../../src/import/cldf/readDataset.js';
import { buildCldfDocuments } from '../../src/import/cldf/buildDocuments.js';
import { deriveSetupData, runCldfImport } from '../../src/import/cldf/importEngine.js';
import { executeProjectSetup } from '../../src/components/projects/setup/executeSetup.js';

const [core, token, zip, name] = process.argv.slice(2);
const client = new PlaidClient(core, token);
const dataset = readCldfDataset(new Uint8Array(readFileSync(zip)));
const build = buildCldfDocuments(dataset);
for (const w of build.warnings || []) console.error('warning:', typeof w === 'string' ? w : JSON.stringify(w));
const setupData = deriveSetupData(build, name);
const setup = await executeProjectSetup({ client, isNewProject: true, setupData });
if (setup.failures.length) throw new Error(setup.failures.join('. '));
const result = await runCldfImport({ client, projectId: setup.projectId, build });
const docs = await client.projects.listDocuments(setup.projectId);
console.log(
  JSON.stringify({
    projectId: setup.projectId,
    documents: docs.map((d) => ({ id: d.id, name: d.name })).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
    stats: build.stats,
    imported: result.imported,
  }),
);
