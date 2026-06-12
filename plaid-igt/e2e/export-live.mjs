// Live e2e for the export feature (scratchpad-convention: disposable).
// Imports a small slice of the Lezgi .fwbackup into a fresh project (same
// flow as import-flex-live.mjs), then drives runExport — plain text + flextext
// at project scope, plus a single-document export — and verifies the archives:
// zip entries, flextext XML well-formedness (saxes), spot-checked content,
// vocab TSV row count vs the lexicon.
//
//   node e2e/export-live.mjs [--keep]
//
// The project is deleted at the end unless --keep is given.

import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { makeClient } from './bugbash/harness.mjs';
import { readFwbackup } from '../src/import/flex/fwbackup.js';
import { parseFwdata } from '../src/import/flex/fwdataParser.js';
import { buildDocuments } from '../src/import/flex/buildDocuments.js';
import { deriveImportConfig, runImport } from '../src/import/flex/importEngine.js';
import { executeProjectSetup } from '../src/components/projects/setup/executeSetup.js';
import { discoverExportLayers } from '../src/export/exportLayers.js';
import { newPreset } from '../src/export/presets.js';
import { runExport } from '../src/export/runExport.js';

const BACKUP = '/home/luke/Downloads/Lezgi-Qusar dialect 2019-12-12 0934 change_comps.fwbackup';
const KEEP = process.argv.includes('--keep');

const failures = [];
const check = (cond, label, detail = '') => {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures.push(label);
};

const parseXml = (xml, label) => {
  const parser = new SaxesParser();
  let error = null;
  parser.on('error', (e) => { error = e; });
  parser.write(xml).close();
  check(!error, `${label} is well-formed XML`, String(error ?? ''));
};

const decode = (u8) => new TextDecoder().decode(u8);

const client = makeClient();
const t0 = Date.now();

// ---- import a small Lezgi slice (3 smallest texts) ----
const { xml } = readFwbackup(new Uint8Array(readFileSync(BACKUP)));
const ir = parseFwdata(xml);
const build = buildDocuments(ir);
build.documents = [...build.documents].sort((a, b) => a.words.length - b.words.length).slice(0, 3);
const config = {
  ...deriveImportConfig(ir, build),
  orthographies: [{ ws: 'lez-Qaaa-AZ-x-Tran-lat', name: 'Translit' }],
};

const projectName = `export-e2e-${Date.now() % 1e7}`;
const setupData = {
  basicInfo: { projectName },
  orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }, ...config.orthographies.map((o) => ({ name: o.name }))] },
  fields: {
    fields: config.fields.map((f) => ({ name: f.name, scope: f.scope, isCustom: true })),
    ignoredTokens: { mode: 'unicode-punctuation', unicodePunctuationExceptions: [], explicitIgnoredTokens: [] },
  },
  vocabulary: { vocabularies: [{ id: 'new-flex', name: `${projectName} Lexicon`, enabled: true, isCustom: true }] },
  documentMetadata: { enabledFields: config.documentMetadata.map((m) => ({ name: m.name, enabled: true, isCustom: true })) },
};
const setup = await executeProjectSetup({ client, isNewProject: true, resumeProjectId: null, setupData });
check(setup.failures.length === 0, 'setup completed', setup.failures.join('; '));
const projectId = setup.projectId;
const vocabId = setup.resources.vocabularies[0].id;

try {
  await runImport({
    client, projectId, build, lexicon: ir.lexicon, config, vocabId,
    onProgress: (p) => {
      if (p.phase === 'document' && p.step === 'Starting') {
        process.stdout.write(`\r  importing ${p.index + 1}/${p.total} ${p.doc.slice(0, 40).padEnd(42)}`);
      }
    },
  });
  console.log(`\nimported in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const project = await client.projects.get(projectId);
  const layers = discoverExportLayers(project);
  check(layers.orthographies.includes('Translit'), 'discovered Translit orthography', JSON.stringify(layers));
  check(layers.morphFields.includes('Gloss'), 'discovered morpheme Gloss field', JSON.stringify(layers));
  check(layers.sentFields.some((f) => /translation/i.test(f)), 'discovered sentence translation field', JSON.stringify(layers));

  // ---- plain text, project scope, with vocab TSVs ----
  const plainPreset = { ...newPreset('plaintext', layers, 'e2e plain'), includeVocabularies: true };
  const plain = await runExport({
    client, project, preset: plainPreset, scope: { type: 'project' },
    onProgress: ({ done, total, name }) => name && console.log(`  plain ${done + 1}/${total} ${name}`),
  });
  check(plain.warnings.length === 0, 'plain export has no warnings', plain.warnings.join('; '));
  check(plain.filename.endsWith('-export.zip'), 'plain export is a zip', plain.filename);
  const plainEntries = unzipSync(new Uint8Array(await plain.blob.arrayBuffer()));
  const plainDocs = Object.keys(plainEntries).filter((p) => p.startsWith('documents/'));
  const tsvs = Object.keys(plainEntries).filter((p) => p.startsWith('vocabularies/'));
  check(plainDocs.length === 3, 'zip has 3 document .txt files', JSON.stringify(plainDocs));
  check(plainDocs.every((p) => p.endsWith('.txt')), 'plain entries end in .txt', JSON.stringify(plainDocs));
  check(tsvs.length === 1, 'zip has 1 vocabulary TSV', JSON.stringify(tsvs));

  const someText = decode(plainEntries[plainDocs[0]]);
  check(/\(\d+\)/.test(someText), 'plain text has sentence numbering');
  check(/Translation: /.test(someText), 'plain text carries a translation line');

  const vocab = await client.vocabLayers.get(vocabId, true);
  const tsvLines = decode(plainEntries[tsvs[0]]).trimEnd().split('\n');
  check(tsvLines.length === (vocab.items?.length ?? 0) + 1,
    `vocab TSV rows = items + header (${(vocab.items?.length ?? 0) + 1})`, `got ${tsvLines.length}`);
  check(tsvLines[0].startsWith('Form\t'), 'vocab TSV header starts with Form', tsvLines[0]);

  // ---- flextext, project scope ----
  const flexPreset = newPreset('flextext', layers, 'e2e flex');
  flexPreset.options.langs.baseline = 'lez';
  const flex = await runExport({
    client, project, preset: flexPreset, scope: { type: 'project' },
    onProgress: ({ done, total, name }) => name && console.log(`  flex ${done + 1}/${total} ${name}`),
  });
  check(flex.warnings.length === 0, 'flextext export has no warnings', flex.warnings.join('; '));
  const flexEntries = unzipSync(new Uint8Array(await flex.blob.arrayBuffer()));
  const flexDocs = Object.keys(flexEntries).filter((p) => p.endsWith('.flextext'));
  check(flexDocs.length === 3, 'zip has 3 .flextext files', JSON.stringify(Object.keys(flexEntries)));

  for (const path of flexDocs) {
    const content = decode(flexEntries[path]);
    parseXml(content, path);
  }
  const allFlex = flexDocs.map((p) => decode(flexEntries[p])).join('\n');
  check(allFlex.includes('lang="lez"'), 'flextext uses the baseline lang tag');
  check(allFlex.includes('<morph type="stem">'), 'flextext has stem morph types');
  check(allFlex.includes('type="segnum"'), 'flextext has segment numbers');
  check(allFlex.includes('type="gls"'), 'flextext has glosses');
  check(allFlex.includes('type="cf"'), 'flextext has citation forms from vocab links');
  check(allFlex.includes('vernacular="true"'), 'flextext declares vernacular languages');

  // ---- single document scope → bare file ----
  const docs = await client.projects.listDocuments(projectId);
  const single = await runExport({
    client, project, preset: flexPreset, scope: { type: 'document', id: docs[0].id },
  });
  check(single.filename.endsWith('.flextext'), 'single-doc export is a bare .flextext', single.filename);
  parseXml(await single.blob.text(), single.filename);

  // ---- native Plaid IGT JSON, project scope ----
  const nativePreset = newPreset('plaid-igt-json', layers, 'e2e native');
  const native = await runExport({
    client, project, preset: nativePreset, scope: { type: 'project' },
    onProgress: ({ done, total, name }) => name && console.log(`  native ${done + 1}/${total} ${name}`),
  });
  check(native.warnings.length === 0, 'native export has no warnings', native.warnings.join('; '));
  const nativeEntries = unzipSync(new Uint8Array(await native.blob.arrayBuffer()));
  const nativeJson = {};
  let parseFailed = null;
  for (const [path, bytes] of Object.entries(nativeEntries)) {
    if (!path.endsWith('.json')) continue;
    try { nativeJson[path] = JSON.parse(decode(bytes)); } catch (e) { parseFailed = `${path}: ${e.message}`; }
  }
  check(!parseFailed, 'every native .json entry parses', parseFailed ?? '');

  const manifest = nativeJson['project.json'];
  check(manifest?.format === 'plaid-igt' && manifest?.formatVersion === 1, 'manifest format/version', JSON.stringify({ format: manifest?.format, formatVersion: manifest?.formatVersion }));
  check(manifest.documents.length === 3, 'manifest lists 3 documents', String(manifest.documents.length));
  check(manifest.documents.every((d) => nativeJson[d.file]), 'manifest files all exist in the zip');
  check(manifest.schema.orthographies.some((o) => o.name === 'Translit'), 'schema lists Translit', JSON.stringify(manifest.schema.orthographies));
  check(manifest.schema.fields.morpheme.some((f) => f.name === 'Gloss'), 'schema lists morpheme Gloss');

  const vocabJson = nativeJson[manifest.vocabularies[0]?.file];
  check(vocabJson?.items?.length === (vocab.items?.length ?? 0), `native vocab has ${vocab.items?.length} items`, String(vocabJson?.items?.length));
  const idsAscending = vocabJson.items.every((it, i) => i === 0 || vocabJson.items[i - 1].id < it.id);
  check(idsAscending, 'native vocab items sorted by id (creation order)');

  const docJson = nativeJson[manifest.documents[0].file];
  const someWord = docJson.sentences.flatMap((s) => s.words).find((w) => w.morphemes.length);
  check(!!someWord, 'native doc has words with morphemes');
  check(someWord.morphemes.every((m, i) => m.precedence === i + 1), 'morpheme precedence is 1-based in order', JSON.stringify(someWord.morphemes.map((m) => m.precedence)));
  const itemIds = new Set(vocabJson.items.map((it) => it.id));
  const linkedMorph = docJson.sentences.flatMap((s) => s.words).flatMap((w) => w.morphemes).find((m) => m.vocab);
  check(!!linkedMorph && itemIds.has(linkedMorph.vocab.itemId), 'a morpheme vocab link resolves to a vocab item', JSON.stringify(linkedMorph?.vocab));
  check(typeof docJson.baseline.body === 'string' && docJson.baseline.body.length > 0, 'native doc carries the baseline body');
  check(docJson.metadata && typeof docJson.metadata === 'object', 'native doc carries raw metadata');

  console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)}s; ${failures.length} failure(s)`);
} finally {
  if (!KEEP) {
    await client.projects.delete(projectId).catch((e) => console.log('cleanup failed:', e.message));
    console.log('project deleted (use --keep to keep it)');
  } else {
    console.log(`kept project ${projectId} (${projectName})`);
  }
}

if (failures.length) {
  console.error('FAILURES:', failures);
  process.exit(1);
}
