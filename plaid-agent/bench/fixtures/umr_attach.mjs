// Set an igt project up for UMR (adoptSubstrate, what the UMR app's adopt
// button does) and attach a .umr file's graphs onto an existing igt document
// whose words are the file's (importUmrDocument with `into`). Run from
// plaid-umr/ (build.sh copies it to plaid-umr/out/bench/):
//
//   node out/bench/umr_attach.mjs CORE TOKEN PROJECT_ID DOCUMENT_ID FILE.umr
//
// Prints one JSON line: {projectId, documentId, warnings, attached}.
import { readFileSync } from 'node:fs';
import PlaidClient from '@larc-iu/plaid-client';
import { adoptSubstrate } from '../../src/domain/umrProjectSetup.js';
import { importUmrDocument } from '../../src/domain/umrImport.js';
import { getUmrLayerInfo } from '../../src/utils/umrLayerUtils.js';

const [core, token, projectId, documentId, file] = process.argv.slice(2);
const client = new PlaidClient(core, token);
await adoptSubstrate(client, { id: projectId });
const info = getUmrLayerInfo(await client.projects.get(projectId));
const doc = await client.documents.get(documentId);
const r = await importUmrDocument(client, projectId, doc.name, readFileSync(file, 'utf8'), info, {
  into: documentId,
});
console.log(JSON.stringify({ projectId, documentId, warnings: r.warnings, attached: r.attached }));
