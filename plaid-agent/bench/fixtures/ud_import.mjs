// Create a ud project with plaid-ud's own setup (createUdProject, what the New
// Project modal calls) and import CoNLL-U documents with its own importer.
// Run from plaid-ud/ (build.sh copies it to plaid-ud/out/bench/):
//
//   node out/bench/ud_import.mjs CORE TOKEN PROJECT_NAME DOC_NAME=FILE [DOC_NAME=FILE ...]
//
// Prints one JSON line: {projectId, documents: [{id, name}], warnings}.
import { readFileSync } from 'node:fs';
import PlaidClient from '@larc-iu/plaid-client';
import { createUdProject } from '../../src/domain/udProjectSetup.js';
import { importConlluDocument } from '../../src/domain/conlluImport.js';
import { getUdLayerInfo } from '../../src/utils/udLayerUtils.js';

const [core, token, projectName, ...pairs] = process.argv.slice(2);
const client = new PlaidClient(core, token);
const created = await createUdProject(client, projectName);
const project = await client.projects.get(created.id);
const info = getUdLayerInfo(project);
const documents = [];
const warnings = [];
for (const pair of pairs) {
  const at = pair.indexOf('=');
  const name = pair.slice(0, at);
  const text = readFileSync(pair.slice(at + 1), 'utf8');
  const r = await importConlluDocument(client, created.id, name, text, info);
  const id = typeof r === 'string' ? r : r?.documentId || r?.id || r?.document?.id;
  documents.push({ id, name });
  for (const w of r?.warnings || r?.importWarnings || []) warnings.push(`${name}: ${w}`);
}
console.log(JSON.stringify({ projectId: created.id, documents, warnings }));
