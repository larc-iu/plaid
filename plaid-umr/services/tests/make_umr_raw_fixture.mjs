// Writes the two fixtures the Python writer is judged against, so that the
// oracle is the app's own code rather than a second reading of the spec:
//
//   fixtures/english_raw.json     one released .umr file run through the app's
//                                 import plan and laid out as the Python
//                                 client's `documents.get(id, include_body=True)`
//                                 hands a document back
//   fixtures/english_expected.umr what `new UmrDocument({ raw }).toUmr()` makes
//                                 of that same document
//
// services/tests/test_umr_ancast.py then asserts the service's own writer
// produces the second file from the first, line for line.
//
// Run from plaid-umr, on Node 24:
//   source ~/.nvm/nvm.sh && nvm use 24.1.0
//   node services/tests/make_umr_raw_fixture.mjs
//
// Regenerate it whenever src/domain/sentenceGraph.js or src/domain/format/
// changes what the exporter writes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../../src/domain/format/umrFile.js';
import { planImport } from '../../src/domain/umrImport.js';
import { UmrDocument } from '../../src/domain/UmrDocument.js';
import { rawFromPlan } from '../../test/storageRoundTrip.test.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, '..', '..', 'test', 'fixtures', 'umr', 'english_umr-0001.umr');
const OUT = path.join(HERE, 'fixtures');

// The layer tree's own keys, as the Python client hands them back. Everything
// under `metadata` and `config` is opaque to both clients and is left exactly
// as it is.
const LAYER_KEYS = {
  textLayers: 'text_layers',
  tokenLayers: 'token_layers',
  spanLayers: 'span_layers',
  relationLayers: 'relation_layers',
};

const toPython = (value) => {
  if (Array.isArray(value)) return value.map(toPython);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    // `metadata` and `config` are opaque: their keys are the app's, not the
    // client's, and no transform touches them.
    out[LAYER_KEYS[key] ?? key] = key === 'metadata' || key === 'config' ? inner : toPython(inner);
  }
  return out;
};

// The two fixtures as text, from the app's own code: what the script writes,
// and what test/serviceFixtures.test.js checks the checked-in files against,
// so a change to the exporter fails loudly instead of leaving them stale.
export function buildFixtures() {
  const text = fs.readFileSync(SOURCE, 'utf8');
  const parsed = parseUmrFile(text);
  const plan = planImport(parsed.sentences, []);
  const raw = rawFromPlan(plan);
  const doc = new UmrDocument({ raw });
  return {
    // Written compactly: it is a fixture for one assertion, not something to read.
    raw: `${JSON.stringify(toPython(raw))}\n`,
    expected: doc.toUmr(),
    doc,
  };
}

export const FIXTURE_PATHS = {
  raw: path.join(OUT, 'english_raw.json'),
  expected: path.join(OUT, 'english_expected.umr'),
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { raw, expected, doc } = buildFixtures();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(FIXTURE_PATHS.raw, raw);
  fs.writeFileSync(FIXTURE_PATHS.expected, expected);
  const sentences = doc.sentences.length;
  const nodes = doc.sentences.reduce((n, s) => n + s.nodes.length, 0);
  const raws = doc.sentences.filter((s) => typeof s.rawGraph === 'string').length;
  console.log(`${sentences} sentences, ${nodes} nodes, ${raws} kept as raw text`);
  console.log(`wrote ${FIXTURE_PATHS.raw}`);
  console.log(`wrote ${FIXTURE_PATHS.expected}`);
}
