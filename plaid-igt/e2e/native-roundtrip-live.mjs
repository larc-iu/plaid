// Live round-trip e2e for the native format (scratchpad-convention:
// disposable). Pipeline against the live core (:8085):
//
//   1. FLEx-import a 2-text Lezgi slice into project A (real importer)
//      + add media and a time-alignment token to one document
//   2. Export A as a Plaid IGT JSON archive
//   3. Import that archive into a fresh project B (the native importer)
//   4. Export B the same way
//   5. Compare the two archives SEMANTICALLY (ids are correlation keys, so
//      both sides are normalized to id-free shapes; the importer's bookkeeping
//      stamps — nativeImportId, nativeImported — are stripped)
//
//   node e2e/native-roundtrip-live.mjs [--keep]
//
// Projects are deleted at the end unless --keep is given.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { makeClient } from './bugbash/harness.mjs';
import { readFwbackup } from '../src/import/flex/fwbackup.js';
import { parseFwdata } from '../src/import/flex/fwdataParser.js';
import { buildDocuments } from '../src/import/flex/buildDocuments.js';
import { deriveImportConfig, runImport } from '../src/import/flex/importEngine.js';
import { executeProjectSetup } from '../src/components/projects/setup/executeSetup.js';
import { findBaselineTextLayer, findAlignmentTokenLayer } from '../src/domain/igtConfig.js';
import { discoverExportLayers } from '../src/export/exportLayers.js';
import { newPreset } from '../src/export/presets.js';
import { runExport } from '../src/export/runExport.js';
import { readNativeArchive } from '../src/import/native/readArchive.js';
import { deriveSetupData, runNativeImport } from '../src/import/native/importEngine.js';

const BACKUP = '/home/luke/Downloads/Lezgi-Qusar dialect 2019-12-12 0934 change_comps.fwbackup';
const KEEP = process.argv.includes('--keep');

const failures = [];
const check = (cond, label, detail = '') => {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures.push(label);
};

const client = makeClient();
const t0 = Date.now();
const createdProjects = [];

// ---- helpers ----------------------------------------------------------------

async function exportNative(projectId) {
  const project = await client.projects.get(projectId);
  const preset = newPreset('plaid-igt-json', discoverExportLayers(project), 'rt');
  const result = await runExport({ client, project, preset, scope: { type: 'project' } });
  check(result.warnings.length === 0, `export of ${project.name} has no warnings`, result.warnings.join('; '));
  return readNativeArchive(new Uint8Array(await result.blob.arrayBuffer()));
}

// Id-free canonical form of an archive for deep comparison. Token references
// become extent descriptors; vocab item references become forms; the
// importer's bookkeeping metadata is stripped.
function normalize(archive) {
  const omit = (obj, keys) => {
    if (!obj) return undefined;
    const out = Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
    return Object.keys(out).length ? out : undefined;
  };
  const itemFormById = new Map();
  for (const v of archive.vocabularies) {
    for (const it of v.data.items || []) itemFormById.set(it.id, it.form);
  }
  const vocabularies = archive.vocabularies.map((v) => ({
    name: v.name,
    fields: v.data.fields,
    items: (v.data.items || []).map((it) => ({
      form: it.form,
      metadata: omit(it.metadata, ['nativeImportId']),
    })),
  })).sort((a, b) => a.name.localeCompare(b.name));

  const documents = archive.documents.map((d) => {
    const data = d.data;
    const tokenDesc = new Map(); // token id → "layer:begin-end[:precedence]"
    const note = (id, s) => { if (id != null) tokenDesc.set(id, s); };
    for (const s of data.sentences || []) {
      note(s.id, `sentence:${s.begin}-${s.end}`);
      for (const w of s.words || []) {
        note(w.id, `word:${w.begin}-${w.end}`);
        for (const m of w.morphemes || []) note(m.id, `morpheme:${m.begin}-${m.end}:${m.precedence}`);
      }
    }
    for (const t of data.orphanTokens || []) note(t.id, `${t.layer}:${t.begin}-${t.end}`);
    for (const a of data.alignment || []) note(a.id, `alignment:${a.begin}-${a.end}`);
    const desc = (id) => tokenDesc.get(id) ?? `unknown:${id}`;

    const fields = (f) => Object.fromEntries(Object.entries(f || {})
      .map(([name, e]) => [name, { value: e.value, metadata: e.metadata }]));
    const vocab = (v) => (v ? { form: itemFormById.get(v.itemId) ?? v.itemId, metadata: v.metadata } : undefined);

    return {
      name: d.name,
      metadata: omit(data.metadata, ['nativeImported']),
      body: data.baseline?.body,
      hasMedia: !!d.mediaBytes,
      sentences: (data.sentences || []).map((s) => ({
        begin: s.begin, end: s.end, metadata: s.metadata,
        fields: fields(s.fields),
        words: (s.words || []).map((w) => ({
          begin: w.begin, end: w.end, text: w.text,
          orthographies: w.orthographies, metadata: w.metadata,
          fields: fields(w.fields), vocab: vocab(w.vocab),
          morphemes: (w.morphemes || []).map((m) => ({
            begin: m.begin, end: m.end, precedence: m.precedence, text: m.text,
            ...('form' in m ? { form: m.form } : {}),
            ...('morphType' in m ? { morphType: m.morphType } : {}),
            metadata: m.metadata, fields: fields(m.fields), vocab: vocab(m.vocab),
          })),
        })),
      })),
      alignment: (data.alignment || []).map((a) => ({
        begin: a.begin, end: a.end, timeBegin: a.timeBegin, timeEnd: a.timeEnd, metadata: a.metadata,
      })),
      extraVocabLinks: (data.extraVocabLinks || [])
        .map((l) => ({ form: itemFormById.get(l.itemId) ?? l.itemId, tokens: (l.tokens || []).map(desc).sort(), metadata: l.metadata }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      extraSpans: (data.extraSpans || [])
        .map((s) => ({ layer: s.layer, tokens: (s.tokens || []).map(desc).sort(), value: s.value, metadata: s.metadata }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      orphanTokens: (data.orphanTokens || [])
        .map((t) => ({ layer: t.layer, begin: t.begin, end: t.end, precedence: t.precedence, metadata: t.metadata }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { schema: archive.manifest.schema, vocabularies, documents };
}

try {
  // ---- 1. project A via the FLEx importer ----
  const { xml } = readFwbackup(new Uint8Array(readFileSync(BACKUP)));
  const ir = parseFwdata(xml);
  const build = buildDocuments(ir);
  build.documents = [...build.documents].sort((a, b) => a.words.length - b.words.length).slice(0, 2);
  const config = {
    ...deriveImportConfig(ir, build),
    orthographies: [{ ws: 'lez-Qaaa-AZ-x-Tran-lat', name: 'Translit' }],
  };
  const nameA = `rt-a-${Date.now() % 1e7}`;
  const setupA = await executeProjectSetup({
    client, isNewProject: true, resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: nameA },
      orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }, ...config.orthographies.map((o) => ({ name: o.name }))] },
      fields: {
        fields: config.fields.map((f) => ({ name: f.name, scope: f.scope, isCustom: true })),
        ignoredTokens: { mode: 'unicode-punctuation', unicodePunctuationExceptions: [], explicitIgnoredTokens: [] },
      },
      vocabulary: { vocabularies: [{ id: 'new-flex', name: `${nameA} Lexicon`, enabled: true, isCustom: true }] },
      documentMetadata: { enabledFields: config.documentMetadata.map((m) => ({ name: m.name, enabled: true, isCustom: true })) },
    },
  });
  check(setupA.failures.length === 0, 'project A setup', setupA.failures.join('; '));
  createdProjects.push(setupA.projectId);
  await runImport({
    client, projectId: setupA.projectId, build, lexicon: ir.lexicon, config,
    vocabId: setupA.resources.vocabularies[0].id,
  });
  console.log(`project A imported in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Media + one sentence-extent alignment token on the first document, so the
  // round-trip exercises both.
  const projectA = await client.projects.get(setupA.projectId);
  const docsA = await client.projects.listDocuments(setupA.projectId);
  const docA = await client.documents.get(docsA[0].id, true);
  const baselineA = findBaselineTextLayer(docA.textLayers);
  const alignLayerA = findAlignmentTokenLayer(findBaselineTextLayer(projectA.textLayers).tokenLayers || []);
  const sentA = baselineA.tokenLayers.find((tl) => tl.config?.plaid?.role === 'sentence').tokens
    .sort((a, b) => a.begin - b.begin)[0];
  await client.documents.uploadMedia(docsA[0].id, new File([new Uint8Array([82, 73, 70, 70, 0, 0])], 'rt.wav'));
  await client.tokens.bulkCreate([{
    tokenLayerId: alignLayerA.id, text: baselineA.text.id,
    begin: sentA.begin, end: sentA.end,
    metadata: { timeBegin: 0.5, timeEnd: 2.25 },
  }]);

  // ---- 2. export A ----
  const archiveA = await exportNative(setupA.projectId);
  check(archiveA.documents.some((d) => d.mediaBytes), 'archive A embeds the media file');
  check(archiveA.documents.some((d) => d.data.alignment.length === 1), 'archive A carries the alignment token');

  // ---- 3. import into project B ----
  const nameB = `rt-b-${Date.now() % 1e7}`;
  const setupB = await executeProjectSetup({
    client, isNewProject: true, resumeProjectId: null,
    setupData: deriveSetupData(archiveA.manifest, nameB),
  });
  check(setupB.failures.length === 0, 'project B setup', setupB.failures.join('; '));
  createdProjects.push(setupB.projectId);
  const importRes = await runNativeImport({
    client, projectId: setupB.projectId, archive: archiveA,
    onProgress: (p) => {
      if (p.phase === 'document' && p.step === 'Starting') {
        console.log(`  importing ${p.index + 1}/${p.total} ${p.doc}`);
      }
    },
  });
  check(importRes.warnings.length === 0, 'native import has no warnings', importRes.warnings.join('; '));
  check(importRes.imported === archiveA.documents.length, 'all documents imported');

  // ---- 4 + 5. export B and compare ----
  const archiveB = await exportNative(setupB.projectId);
  const normA = normalize(archiveA);
  const normB = normalize(archiveB);

  const compare = (label, a, b) => {
    try {
      assert.deepEqual(b, a);
      check(true, label);
    } catch (e) {
      check(false, label, e.message.split('\n').slice(0, 12).join('\n'));
    }
  };
  compare('schema round-trips', normA.schema, normB.schema);
  compare('vocabularies round-trip (forms, fields, metadata, ORDER)', normA.vocabularies, normB.vocabularies);
  normA.documents.forEach((dA, i) => {
    compare(`document "${dA.name}" round-trips`, dA, normB.documents[i]);
  });
  check(normB.documents.some((d) => d.hasMedia), 'media survived the round trip');
  check(normB.documents.some((d) => d.alignment.length === 1
    && d.alignment[0].timeBegin === 0.5 && d.alignment[0].timeEnd === 2.25),
  'alignment times survived the round trip');

  console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)}s; ${failures.length} failure(s)`);
} finally {
  if (!KEEP) {
    for (const id of createdProjects) {
      await client.projects.delete(id).catch((e) => console.log('cleanup failed:', e.message));
    }
    console.log(`${createdProjects.length} project(s) deleted (use --keep to keep them)`);
  } else {
    console.log(`kept projects: ${createdProjects.join(', ')}`);
  }
}

if (failures.length) {
  console.error('FAILURES:', failures);
  process.exit(1);
}
