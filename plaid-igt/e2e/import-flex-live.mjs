// Live e2e for the FLEx .fwbackup import (scratchpad-convention: disposable).
// Drives the REAL setup + import engine against the live core (:8085) with the
// Lezgi sample, exercising cancel/resume, then verifies the imported data via
// IgtDocument (the exact read path the editor uses).
//
//   node e2e/import-flex-live.mjs [--keep] [--small]
//
// --small imports only the 3 smallest texts (quick smoke run).
// The project is deleted at the end unless --keep is given.

import { readFileSync } from 'node:fs';
import { makeClient } from './bugbash/harness.mjs';
import { cpSlice } from '@larc-iu/plaid-client';
import { readFwbackup } from '../src/import/flex/fwbackup.js';
import { parseFwdata } from '../src/import/flex/fwdataParser.js';
import { buildDocuments } from '../src/import/flex/buildDocuments.js';
import { deriveImportConfig, runImport } from '../src/import/flex/importEngine.js';
import { executeProjectSetup } from '../src/components/projects/setup/executeSetup.js';
import { IgtDocument } from '../src/domain/IgtDocument.js';

const BACKUP = '/home/luke/local/plaid/Lezgi-Qusar dialect 2019-12-12 0934 change_comps.fwbackup';
const KEEP = process.argv.includes('--keep');
const SMALL = process.argv.includes('--small');

const failures = [];
const check = (cond, label, detail = '') => {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures.push(label);
};

const client = makeClient();
const t0 = Date.now();

// ---- parse ----
const { name, xml } = readFwbackup(new Uint8Array(readFileSync(BACKUP)));
const ir = parseFwdata(xml);
const build = buildDocuments(ir);
if (SMALL) {
  build.documents = [...build.documents].sort((a, b) => a.words.length - b.words.length).slice(0, 3);
}
const config = {
  ...deriveImportConfig(ir, build),
  // exercise orthography renaming
  orthographies: [{ ws: 'lez-Qaaa-AZ-x-Tran-lat', name: 'Translit' }],
};
console.log(`parsed in ${Date.now() - t0}ms:`, JSON.stringify(build.stats));

// ---- setup ----
const projectName = `flex-import-e2e-${Date.now() % 1e7}`;
const vocabName = `${projectName} Lexicon`;
const setupData = {
  basicInfo: { projectName },
  orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }, ...config.orthographies.map((o) => ({ name: o.name }))] },
  fields: {
    fields: config.fields.map((f) => ({ name: f.name, scope: f.scope, isCustom: true })),
    ignoredTokens: { mode: 'unicode-punctuation', unicodePunctuationExceptions: [], explicitIgnoredTokens: [] },
  },
  vocabulary: { vocabularies: [{ id: 'new-flex', name: vocabName, enabled: true, isCustom: true }] },
  documentMetadata: { enabledFields: config.documentMetadata.map((m) => ({ name: m.name, enabled: true, isCustom: true })) },
};
const setup = await executeProjectSetup({ client, isNewProject: true, resumeProjectId: null, setupData });
check(setup.failures.length === 0, 'setup completed', setup.failures.join('; '));
const projectId = setup.projectId;
const vocabId = setup.resources.vocabularies[0].id;
console.log(`project ${projectId} set up in ${Date.now() - t0}ms`);

try {
  // ---- import with mid-run cancel, then resume ----
  let docsDone = 0;
  const stopAfter = SMALL ? 1 : 3;
  let cancelled = false;
  try {
    await runImport({
      client, projectId, build, lexicon: ir.lexicon, config, vocabId,
      shouldStop: () => docsDone >= stopAfter,
      onProgress: (p) => {
        if (p.phase === 'document' && p.step === 'Linking lexicon') docsDone += 1;
      },
    });
  } catch (e) {
    cancelled = /cancelled/.test(e.message);
    if (!cancelled) throw e;
  }
  check(cancelled, `import cancelled mid-run after ~${stopAfter} documents`);

  const t1 = Date.now();
  const res = await runImport({
    client, projectId, build, lexicon: ir.lexicon, config, vocabId,
    onProgress: (p) => {
      if (p.phase === 'document' && p.step === 'Starting') {
        process.stdout.write(`\r  importing ${p.index + 1}/${p.total} ${p.doc.slice(0, 40).padEnd(42)}`);
      }
    },
  });
  console.log(`\nresume finished in ${((Date.now() - t1) / 1000).toFixed(1)}s:`, JSON.stringify(res));
  check(res.skipped >= stopAfter - 1, 'resume skipped completed documents', JSON.stringify(res));
  check(res.imported + res.skipped === build.documents.length, 'all documents accounted for');

  // ---- verify ----
  const docs = await client.projects.listDocuments(projectId);
  check(docs.length === build.documents.length, `document count = ${build.documents.length}`, `got ${docs.length}`);

  const vocab = await client.vocabLayers.get(vocabId, true);
  const expectItems = ir.lexicon.reduce((n, e) => n + Math.max(1, e.senses.length), 0)
    - ir.lexicon.filter((e) => !(e.forms?.[build.baselineWs] ?? Object.values(e.forms ?? {})[0])).length;
  check(Math.abs((vocab.items?.length ?? 0) - expectItems) <= 2,
    `lexicon items ≈ ${expectItems}`, `got ${vocab.items?.length}`);

  // Deep-check the Sea Princess via the editor's own read path
  const target = build.documents.find((d) => d.names?.en === 'The Sea Princess') ?? build.documents[0];
  const docEntry = docs.find((d) => d.name === target.name);
  check(!!docEntry, `document "${target.name}" exists`);
  const doc = await IgtDocument.load(client, projectId, docEntry.id);

  check(doc.body === target.body, 'body round-trips exactly');
  const sentences = doc.sortedSentences;
  check(sentences.length === target.sentences.length, `sentence count = ${target.sentences.length}`, `got ${sentences.length}`);

  const s0 = sentences[0];
  const tokens = s0.tokens;
  const expected = target.words.filter((w) => w.begin < target.sentences[0].end);
  check(tokens.length === expected.length, `sentence 1 has ${expected.length} words`, `got ${tokens.length}`);
  check(tokens.every((t, i) => cpSlice(doc.body, t.begin, t.end) === cpSlice(target.body, expected[i].begin, expected[i].end)),
    'sentence 1 word extents match');

  if (target.names?.en === 'The Sea Princess') {
    check(tokens[0].content === 'За', 'first word surface "За"');
    check(tokens[0].annotations?.Gloss?.value === 'I-ERG', 'word gloss I-ERG', JSON.stringify(tokens[0].annotations));
    check(tokens[0].orthographies?.Translit === 'za', 'renamed orthography Translit=za', JSON.stringify(tokens[0].orthographies));
    const m0 = tokens[0].morphemes?.[0];
    check(m0?.metadata?.form === 'за', 'morpheme form metadata');
    check(m0?.metadata?.morphType === 'stem', 'morpheme morphType metadata');
    check(m0?.annotations?.Gloss?.value === '1sg-ERG', 'morpheme gloss');
    check(m0?.annotations?.POS?.value != null, 'morpheme POS present');
    check(!!m0?.vocabItem, 'morpheme linked to lexicon item');
    check(s0.annotations?.Translation?.value?.includes('Sea Princess'), 'free translation on sentence');
    const noteOk = sentences.some((s) => s.annotations?.Note?.value);
    check(noteOk, 'at least one sentence note imported');
  }

  // morphType-driven affix joints reachable from the island's data
  const anyClitic = sentences.flatMap((s) => s.tokens).flatMap((t) => t.morphemes ?? [])
    .some((m) => (m.metadata?.morphType ?? '').includes('clitic'));
  console.log(`  (clitic morphemes present in this document: ${anyClitic})`);

  // the IGT invariant should hold without healing
  const heal = await doc.reconcileOnOpen();
  check(heal.created === 0 && heal.deleted === 0, 'reconcileOnOpen heals nothing', JSON.stringify(heal));

  // every imported vocab link is provenance-confirmed
  const links = doc.layerInfo?.primaryTokenLayer ? null : null; // links live under vocabs in raw
  void links;
  const rawLinks = (doc.raw?.textLayers ?? []).flatMap((tl) => tl.tokenLayers ?? [])
    .flatMap((tkl) => tkl.vocabs ?? []).flatMap((v) => v.vocabLinks ?? []);
  check(rawLinks.length > 0, 'document has vocab links', String(rawLinks.length));
  check(rawLinks.every((l) => l.metadata?.prov === 'inferred' && l.metadata?.provSource === 'flex-import'),
    'all links stamped flex-import');
  const confirmedLinks = rawLinks.filter((l) => l.metadata?.provConfirmed === true).length;
  check(confirmedLinks > 0, 'human-approved analyses imported as confirmed links');
  console.log(`  (links: ${confirmedLinks} confirmed / ${rawLinks.length - confirmedLinks} parser-guess unconfirmed)`);

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
