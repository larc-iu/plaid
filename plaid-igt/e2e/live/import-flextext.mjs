// Live e2e for the FLEx .flextext import. Drives the REAL setup and import
// engine against the live core (:8085) with real files, stops the run part way
// and resumes it, then reads every document back through IgtDocument (the
// editor's own read path) and counts it against what the files hold.
//
//   node --import ./e2e/live/aliases.mjs e2e/live/import-flextext.mjs [--keep] [files…]
//
// With no files it reads ~/Downloads/lezgi.flextext (FieldWorks' own export).
// The project is deleted at the end unless --keep is given.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { makeClient } from '../bugbash/harness.mjs';
import { cpSlice } from '@larc-iu/plaid-client';
import { parseFlextextFiles } from '../../src/import/flex/flextextParser.js';
import { buildDocuments } from '../../src/import/flex/buildDocuments.js';
import { deriveImportConfig, runImport } from '../../src/import/flex/importEngine.js';
import { executeProjectSetup } from '../../src/components/projects/setup/executeSetup.js';
import { IgtDocument } from '../../src/domain/IgtDocument.js';

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const paths = args.filter((a) => !a.startsWith('--'));
const FILES = paths.length ? paths : ['/home/luke/Downloads/lezgi.flextext'];

const failures = [];
const check = (cond, label, detail = '') => {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures.push(label);
};

const client = makeClient();
const t0 = Date.now();

// ---- parse ----
const ir = parseFlextextFiles(
  FILES.map((p) => ({ name: basename(p), xml: readFileSync(p, 'utf8') })),
);
const build = buildDocuments(ir);
const config = deriveImportConfig(ir, build);
console.log(`parsed in ${Date.now() - t0}ms:`, JSON.stringify(build.stats));
console.log('not read:', JSON.stringify(ir.unread), 'warnings:', ir.warnings.length);

// ---- setup ----
const projectName = `flextext-import-e2e-${Date.now() % 1e7}`;
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
      fields: config.fields.map((f) => ({
        name: f.name,
        scope: f.scope,
        lang: f.ws ?? null,
        isCustom: true,
      })),
      ignoredTokens: {
        mode: 'unicode-punctuation',
        unicodePunctuationExceptions: [],
        explicitIgnoredTokens: [],
      },
    },
    vocabulary: { vocabularies: [] },
    documentMetadata: {
      enabledFields: config.documentMetadata.map((m) => ({
        name: m.name,
        enabled: true,
        isCustom: true,
      })),
    },
  },
});
check(setup.failures.length === 0, 'setup completed', setup.failures.join('; '));
const projectId = setup.projectId;

try {
  // ---- import, stopped part way, then resumed ----
  const run = (shouldStop, onProgress) =>
    runImport({
      operation: 'Import FLEx texts',
      client,
      projectId,
      build,
      lexicon: ir.lexicon,
      config,
      vocabId: null,
      shouldStop,
      onProgress,
    });
  const stopAfter = Math.min(2, build.documents.length - 1);
  let started = 0;
  let cancelled = false;
  try {
    await run(
      () => started > stopAfter,
      (p) => {
        if (p.phase === 'document' && p.step === 'Starting') started += 1;
      },
    );
  } catch (e) {
    cancelled = /cancelled/i.test(e.message);
    if (!cancelled) throw e;
  }
  check(cancelled || stopAfter < 1, `import stopped after ${stopAfter} documents`);
  const t1 = Date.now();
  const res = await run(null, null);
  console.log(`resumed in ${((Date.now() - t1) / 1000).toFixed(1)}s:`, JSON.stringify(res));
  check(res.imported + res.skipped === build.documents.length, 'every document accounted for');

  const project = await client.projects.get(projectId);
  check((project.vocabs ?? []).length === 0, 'no vocabulary made');

  // ---- every document, read back ----
  const docs = await client.projects.listDocuments(projectId);
  check(docs.length === build.documents.length, `${build.documents.length} documents`);
  // By the id each document was stamped with at import, since two texts may
  // share a name.
  const bySource = new Map();
  for (const d of docs) {
    const full = await client.documents.get(d.id);
    bySource.set(full?.metadata?.importSource, d);
  }
  const values = (list, key) => list.filter((x) => key(x) != null).length;
  let bodies = 0;
  let words = 0;
  let morphemes = 0;
  let wordGlosses = 0;
  let translations = 0;
  const wantWords = build.stats.words;
  const glossField = config.fields.find((f) => f.kind === 'wordGloss');
  const trField = config.fields.find((f) => f.kind === 'freeTranslation');
  let wantGlosses = 0;
  let wantTranslations = 0;
  for (const target of build.documents) {
    const entry = bySource.get(target.guid);
    if (!entry) {
      check(false, `document "${target.name}" exists`);
      continue;
    }
    const doc = await IgtDocument.load(client, projectId, entry.id);
    if (doc.body === target.body) bodies += 1;
    const tokens = doc.sortedSentences.flatMap((s) => s.tokens);
    words += tokens.length;
    morphemes += tokens.reduce(
      (n, t) => n + (t.morphemes ?? []).filter((m) => !m.virtual).length,
      0,
    );
    if (glossField) {
      wordGlosses += values(tokens, (t) => t.annotations?.[glossField.name]?.value);
      wantGlosses += values(target.words, (w) => w.gloss?.[glossField.ws]);
    }
    if (trField) {
      translations += values(doc.sortedSentences, (s) => s.annotations?.[trField.name]?.value);
      wantTranslations += values(target.sentences, (s) => s.freeTranslation?.[trField.ws]);
    }
    const first = target.words[0];
    if (first) {
      check(
        cpSlice(doc.body, tokens[0].begin, tokens[0].end) ===
          cpSlice(target.body, first.begin, first.end),
        `"${target.name}" starts with its first word`,
      );
    }
  }
  check(bodies === build.documents.length, 'every text round-trips exactly', `${bodies}`);
  check(words === wantWords, `${wantWords} words`, `got ${words}`);
  check(morphemes === build.stats.morphemes, `${build.stats.morphemes} morphemes`, `${morphemes}`);
  if (glossField) {
    check(wordGlosses === wantGlosses, `${wantGlosses} word glosses`, `got ${wordGlosses}`);
  }
  if (trField) {
    check(
      translations === wantTranslations,
      `${wantTranslations} translations`,
      `got ${translations}`,
    );
  }
} finally {
  if (KEEP) console.log(`kept project ${projectId} (${projectName})`);
  else await client.projects.delete(projectId);
}

console.log(
  `\n${failures.length ? `${failures.length} FAILED` : 'all ok'} in ${Date.now() - t0}ms`,
);
process.exit(failures.length ? 1 : 0);
