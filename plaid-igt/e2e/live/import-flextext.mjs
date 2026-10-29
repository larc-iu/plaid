// Live e2e for the FLEx .flextext import. Drives the REAL setup and import
// engine against the live core (:8085) with real files, then reads every
// document back through IgtDocument (the editor's own read path) and counts it
// against what the files hold.
//
//   node --import ./e2e/live/aliases.mjs e2e/live/import-flextext.mjs [--keep] [files…]
//
// With no files it reads lezgi.flextext (FieldWorks' own export) from the
// fixtures folder (src/test/fixturesDir.js).
// The project is deleted at the end unless --keep is given.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { makeClient } from '../bugbash/harness.mjs';
import { cpSlice } from '@larc-iu/plaid-client';
import { parseFlextextFiles } from '../../src/import/flex/flextextParser.js';
import { buildDocuments } from '../../src/import/flex/buildDocuments.js';
import { deriveImportConfig, runImport } from '../../src/import/flex/importEngine.js';
import { executeProjectSetup } from '../../src/components/projects/setup/executeSetup.js';
import { setupDataFor } from '../../src/import/project.js';
import { IgtDocument } from '../../src/domain/IgtDocument.js';
import { readIgnoredTokens } from '../../src/domain/igtConfig.js';
import { isTokenIgnored } from '@ui/domain/igtWordBreaks.js';
import { fixture } from '../../src/test/fixturesDir.js';

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const paths = args.filter((a) => !a.startsWith('--'));
const FILES = paths.length ? paths : [fixture('lezgi.flextext')];

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
  // What the import screen hands setup (ImportFlexProject.jsx).
  setupData: setupDataFor({
    projectName,
    orthographies: config.orthographies.map((o) => o.name),
    fields: config.fields.map((f) => ({
      name: f.name,
      scope: f.scope,
      lang: f.ws ?? null,
      lexiconField: f.lexiconField,
      sentenceRole: f.sentenceRole,
    })),
    vocabularies: [],
    documentMetadata: config.documentMetadata.map((m) => m.name),
  }),
});
check(setup.failures.length === 0, 'setup completed', setup.failures.join('; '));
const projectId = setup.projectId;

try {
  // ---- import ----
  // The documents the run makes, in the order it makes them, which is the
  // build's order: two texts may share a name.
  const made = [];
  const create = client.documents.create.bind(client.documents);
  client.documents.create = async (...a) => {
    const doc = await create(...a);
    made.push(doc.id ?? doc);
    return doc;
  };
  const t1 = Date.now();
  const res = await runImport({
    operation: 'Import FLEx texts',
    client,
    projectId,
    build,
    lexicon: ir.lexicon,
    config,
    vocabId: null,
  });
  client.documents.create = create;
  console.log(`imported in ${((Date.now() - t1) / 1000).toFixed(1)}s:`, JSON.stringify(res));
  check(res.imported === build.documents.length, 'every document imported');

  const project = await client.projects.get(projectId);
  check((project.vocabs ?? []).length === 0, 'no vocabulary made');

  // ---- every document, read back ----
  const docs = await client.projects.listDocuments(projectId);
  check(docs.length === build.documents.length, `${build.documents.length} documents`);
  const values = (list, key) => list.filter((x) => key(x) != null).length;
  let bodies = 0;
  let words = 0;
  let morphemes = 0;
  let wordGlosses = 0;
  let translations = 0;
  // The build leaves a word the ignored-token rule reads as text (a lone
  // "-") as text, so every word it holds is stored and the grid reads every
  // stored one: the two counts are equal, and each is checked on its own.
  let stored = 0;
  let wantWords = 0;
  const glossField = config.fields.find((f) => f.kind === 'wordGloss');
  const trField = config.fields.find((f) => f.kind === 'freeTranslation');
  let wantGlosses = 0;
  let wantTranslations = 0;
  for (const [i, target] of build.documents.entries()) {
    if (!made[i]) {
      check(false, `document "${target.name}" exists`);
      continue;
    }
    const doc = await IgtDocument.load(client, { projectId, documentId: made[i] });
    if (doc.body === target.body) bodies += 1;
    const tokens = doc.sortedSentences.flatMap((s) => s.tokens);
    words += tokens.length;
    stored += doc.layerInfo.primaryTokenLayer.tokens.length;
    const rule = readIgnoredTokens(doc.layerInfo.primaryTokenLayer.config);
    wantWords += target.words.filter(
      (w) => !isTokenIgnored(cpSlice(target.body, w.begin, w.end), rule),
    ).length;
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
  check(stored === build.stats.words, `${build.stats.words} words stored`, `got ${stored}`);
  check(words === wantWords, `${wantWords} words read`, `got ${words}`);
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
