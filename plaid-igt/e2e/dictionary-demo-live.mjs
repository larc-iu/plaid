// Seed a dictionary demo from a FLEx backup (scratchpad-convention: disposable).
// Runs the REAL setup + import engine against the live core (:8085) with
// FLEx's variants on, then dresses the lexicon up the
// way a lexicographer would: a reference field of its own (See also), an
// entry-only field (Etymology), and one example promoted from the
// concordance. The project is KEPT.
//
//   node e2e/dictionary-demo-live.mjs [--docs N]      (default 8 smallest texts)
//   PLAID_FWBACKUP=... to pick another backup.

import { readFileSync } from 'node:fs';
import { makeClient } from './bugbash/harness.mjs';
import { readFwbackup } from '../src/import/flex/fwbackup.js';
import { parseFwdata } from '../src/import/flex/fwdataParser.js';
import { buildDocuments } from '../src/import/flex/buildDocuments.js';
import { deriveImportConfig, runImport } from '../src/import/flex/importEngine.js';
import { executeProjectSetup } from '../src/components/projects/setup/executeSetup.js';

const BACKUP = process.env.PLAID_FWBACKUP || '/home/luke/Downloads/Sena 3 2018-09-11 1145.fwbackup';
const docsArg = process.argv.indexOf('--docs');
const DOCS = docsArg > 0 ? Number(process.argv[docsArg + 1]) : 8;

const client = makeClient();
const t0 = Date.now();

const { xml } = readFwbackup(new Uint8Array(readFileSync(BACKUP)));
const ir = parseFwdata(xml);
const build = buildDocuments(ir);
build.documents = [...build.documents]
  .sort((a, b) => a.words.length - b.words.length)
  .slice(0, DOCS);
const config = { ...deriveImportConfig(ir, build), variants: true };
console.log(`parsed in ${Date.now() - t0}ms:`, JSON.stringify(build.stats));

const projectName = `Dictionary demo (${ir.projectName || 'FLEx'})`;
const vocabName = `${projectName} Lexicon`;
// Reusable: a second run finds the project and only re-dresses the lexicon.
let projectId;
let vocabId;
const found = (await client.projects.list()).find((p) => p.name === projectName);
if (found) {
  projectId = found.id;
  vocabId = (await client.projects.get(projectId)).vocabs[0].id;
  console.log(`reusing project ${projectId}`);
} else {
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName },
      orthographies: {
        orthographies: [
          { name: 'Baseline', isBaseline: true },
          ...config.orthographies.map((o) => ({ name: o.name })),
        ],
      },
      fields: {
        fields: config.fields.map((f) => ({ name: f.name, scope: f.scope, isCustom: true })),
        ignoredTokens: {
          mode: 'unicode-punctuation',
          unicodePunctuationExceptions: [],
          explicitIgnoredTokens: [],
        },
      },
      vocabulary: {
        vocabularies: [{ id: 'new-flex', name: vocabName, enabled: true, isCustom: true }],
      },
      documentMetadata: {
        enabledFields: config.documentMetadata.map((m) => ({
          name: m.name,
          enabled: true,
          isCustom: true,
        })),
      },
    },
  });
  if (setup.failures.length) throw new Error(setup.failures.join('; '));
  projectId = setup.projectId;
  vocabId = setup.resources.vocabularies[0].id;

  const res = await runImport({
    client,
    projectId,
    build,
    lexicon: ir.lexicon,
    config,
    vocabId,
    onProgress: (p) => {
      if (p.phase === 'document' && p.step === 'Starting')
        process.stdout.write(
          `\r  importing ${p.index + 1}/${p.total} ${p.doc.slice(0, 40).padEnd(42)}`,
        );
    },
  });
  console.log(`\nimported in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(res));
}

// ---- dress the lexicon up ----
const layer = await client.vocabLayers.get(vocabId, true);
const fields = { ...(layer.config?.igt?.fields ?? {}) };
fields.seeAlso = { inline: false, type: 'item', many: true };
fields.etymology = { inline: false, scope: 'entry' };
await client.vocabLayers.setConfig(vocabId, 'igt', 'fields', fields);

const items = layer.items || [];
const roots = items.filter((it) => !it.metadata?.parent);
const withSenses = roots.filter((r) => items.some((it) => it.metadata?.parent === r.id));
console.log(`${items.length} items, ${roots.length} entries, ${withSenses.length} with senses`);

// A cross-reference of the reader's own: one homograph points at the other.
// (The variants FLEx knows about came in with the import.)
const byForm = new Map();
for (const r of roots) byForm.set(r.form, [...(byForm.get(r.form) || []), r]);
const homs = [...byForm.values()].find((g) => g.length >= 2);
if (homs) {
  const [main, other] = homs;
  await client.vocabItems.setMetadata(main.id, {
    ...(main.metadata || {}),
    seeAlso: [other.id],
    etymology: 'Demo: an entry-only field',
    status: 'reviewed',
  });
  console.log(`see also: ${main.form} -> ${other.form}`);
}
const variants = items.filter((it) => it.metadata?.variantOf || it.metadata?.components);
console.log(`${variants.length} entries came in as variants or complex forms`);

// An example: the busiest linked entry gets its first attested sentence.
const usage = await client.query({
  where: [
    ['vocab', '?v', { layer: vocabId }],
    ['vocab-link', '?t', '?v'],
  ],
  find: ['?v', '?t'],
  limit: 2000,
});
const counts = new Map();
for (const [v] of usage?.results || []) counts.set(String(v), (counts.get(String(v)) || 0) + 1);
const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
if (busiest) {
  const [itemId] = busiest;
  const tokenId = String((usage.results || []).find((r) => String(r[0]) === itemId)[1]);
  const docRes = await client.query({
    where: [
      ['token', '?t', { doc: { var: '?d' } }],
      ['=', '?t.id', tokenId],
    ],
    return: { group: ['?d'], aggregates: [['count']] },
  });
  const docId = String(docRes.results[0][0]);
  const item = items.find((it) => it.id === itemId);
  const examples = (item.metadata?.examples || []).filter((e) => e.token !== tokenId);
  await client.vocabItems.setMetadata(itemId, {
    ...(item.metadata || {}),
    examples: [...examples, { document: docId, token: tokenId }],
    status: 'published',
  });
  console.log(`example on "${item.form}" (${busiest[1]} uses)`);
}

console.log(`\nproject  http://localhost:5174/#/projects/${projectId}`);
console.log(`lexicon  http://localhost:5174/#/vocabularies/${vocabId}`);
if (withSenses[0])
  console.log(
    `an entry with senses  http://localhost:5174/#/vocabularies/${vocabId}?item=${withSenses[0].id}`,
  );
