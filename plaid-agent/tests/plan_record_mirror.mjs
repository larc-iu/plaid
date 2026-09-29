// plaid-ui's compactPlan, run over the plan items test_plan_record_mirror.py
// generates, so the service's compact_plan can be compared with it. Each item
// is read as the browser reads the record (the client recases the stored
// kebab-case keys to camelCase), compacted, and written back the way the
// browser writes it.
//
// Reads a cases JSON path as argv[2] and writes the results to stdout.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { compactPlan } = await import(`${ROOT}/plaid-ui/src/components/assistant/planRecord.js`);
const { transformRequest, transformResponse } = await import(
  `${ROOT}/plaid-client-js/src/transforms.js`
);

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const results = cases.map((stored) => transformRequest(compactPlan(transformResponse(stored))));
process.stdout.write(JSON.stringify(results));
