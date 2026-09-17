// The round trip on REAL corpora: every .fwbackup in a directory is imported
// with the real FLEx importer, and the project it makes goes through the same
// round trip and the same loss list as the kitchen sink.
//
//   node --import ./e2e/live/aliases.mjs e2e/fidelity/realFiles.mjs \
//     [--dir <path>] [--file <path>] [--format native,cldf,elan] \
//     [--docs N] [--keep] [--out <dir>]
//
// The kitchen sink is what we thought to write down. A real FieldWorks project
// is what people actually have: writing systems we did not think of, texts
// that are half analyzed, lexicons with thousands of entries and relations
// between them. A difference here is a bug the catalog did not describe.
//
// --docs caps each project at its N smallest texts, which is what makes the
// sweep quick enough to run often; without it every text is imported.
//
// The core is the campaign's private one (core.mjs), never the dev core.
// PLAID_FIDELITY_CORE_URL and PLAID_FIDELITY_TOKEN point it at a running one.

import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { attribute, diffSnapshots } from '../../src/test/fidelity/compare.js';
import { expectRoundTrip } from '../../src/test/fidelity/expect/index.js';
import cldfList from '../../src/test/fidelity/formats/cldf.js';
import elanList from '../../src/test/fidelity/formats/elan.js';
import nativeList from '../../src/test/fidelity/formats/native.js';
import { executeProjectSetup } from '../../src/components/projects/setup/executeSetup.js';
import { buildDocuments } from '../../src/import/flex/buildDocuments.js';
import { readFwbackup } from '../../src/import/flex/fwbackup.js';
import { parseFwdata } from '../../src/import/flex/fwdataParser.js';
import { deriveImportConfig, runImport } from '../../src/import/flex/importEngine.js';
import { coreForRun } from './core.mjs';
import { exportProject, importProject } from './drivers.mjs';
import { canonicalExport, diffExports } from './fixedPoint.mjs';
import { snapshotProject } from './snapshot.mjs';

const LISTS = { native: nativeList, cldf: cldfList, elan: elanList };
const DEFAULT_DIR = '/home/luke/Downloads/fwsamples';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const formats = (arg('--format') ?? 'native').split(',');
const docCap = Number(arg('--docs') ?? 0);
const outDir = arg('--out');
const keep = process.argv.includes('--keep');
for (const f of formats) if (!LISTS[f]) throw new Error(`unknown format ${f}`);

const one = arg('--file');
const dir = arg('--dir', DEFAULT_DIR);
const backups = one
  ? [one]
  : readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.fwbackup'))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(a).size - statSync(b).size);
if (!backups.length) throw new Error(`no .fwbackup files in ${dir}`);

const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

async function save(name, value) {
  if (!outDir) return;
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, name);
  if (value instanceof Uint8Array) await writeFile(path, value);
  else await writeFile(path, JSON.stringify(value, null, 2));
}

/** A project holding nothing but what setup gives one, for the shapes it writes. */
async function bareProject(client, name) {
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: name },
      orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }] },
      fields: {
        fields: [{ name: 'Gloss', scope: 'Morpheme' }],
        ignoredTokens: {
          mode: 'unicode-punctuation',
          unicodePunctuationExceptions: [],
          explicitIgnoredTokens: [],
        },
      },
      vocabulary: {
        vocabularies: [
          { id: 'new-lexicon', name: `${name} Lexicon`, enabled: true, isCustom: true },
        ],
      },
    },
  });
  if (setup.failures.length) throw new Error(`bare setup: ${setup.failures.join('; ')}`);
  return setup.projectId;
}

/**
 * One .fwbackup imported the way the import screen imports it: the config the
 * importer derives, a project set up from that config, then the real engine.
 */
async function importBackup(client, path, name) {
  const { xml } = readFwbackup(new Uint8Array(readFileSync(path)));
  const ir = parseFwdata(xml);
  const build = buildDocuments(ir);
  const stats = { ...build.stats, documents: build.documents.length };
  if (docCap > 0 && build.documents.length > docCap) {
    build.documents = [...build.documents]
      .sort((a, b) => a.words.length - b.words.length)
      .slice(0, docCap);
  }
  const config = deriveImportConfig(ir, build, {});
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: name },
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
        vocabularies: [{ id: 'new-flex', name: `${name} Lexicon`, enabled: true, isCustom: true }],
      },
      documentMetadata: {
        enabledFields: (config.documentMetadata || []).map((m) => ({
          name: m.name,
          enabled: true,
          isCustom: true,
        })),
      },
    },
  });
  if (setup.failures.length) throw new Error(`setup: ${setup.failures.join('; ')}`);
  const result = await runImport({
    client,
    projectId: setup.projectId,
    build,
    lexicon: ir.lexicon,
    config,
    vocabId: setup.resources.vocabularies[0].id,
  });
  return { projectId: setup.projectId, stats, imported: result, warnings: build.warnings || [] };
}

const core = await coreForRun({ keep });
let failures = 0;
try {
  const client = core.client;
  console.log(`core at ${core.url} (${secs()})`);
  const bareId = await bareProject(client, `Bare ${Date.now() % 1e6}`);
  const bare = await snapshotProject(client, bareId);

  for (const path of backups) {
    const label = path
      .split('/')
      .pop()
      .replace(/\.fwbackup$/i, '');
    const name = `${label} ${Date.now() % 1e6}`;
    let source;
    let projectId;
    try {
      const done = await importBackup(client, path, name);
      projectId = done.projectId;
      console.log(
        `\n${label}: ${JSON.stringify(done.stats)}${docCap ? ` (${docCap} smallest imported)` : ''} (${secs()})`,
      );
      for (const w of done.warnings.slice(0, 5)) console.log(`       import warning: ${w}`);
      if (done.warnings.length > 5) {
        console.log(`       ... ${done.warnings.length - 5} more import warnings`);
      }
      source = await snapshotProject(client, projectId);
    } catch (err) {
      failures += 1;
      console.log(`\n${label}\n  FAIL the FLEx import: ${err.message}`);
      continue;
    }

    for (const format of formats) {
      const list = LISTS[format];
      let exported;
      let imported;
      try {
        exported = await exportProject(client, projectId, format);
        await save(`${format}.${label}.export`, exported.bytes);
        imported = await importProject(client, format, exported.bytes, name);
      } catch (err) {
        failures += 1;
        console.log(`  FAIL ${list.name}: ${err.message}`);
        continue;
      }
      const actual = await snapshotProject(client, imported.projectId);
      const { expected, actual: got } = expectRoundTrip({ list, source, actual, bare });
      const diffs = diffSnapshots(expected, got);
      if (!diffs.length) console.log(`  ok   ${list.name}`);
      else {
        failures += 1;
        console.log(`  FAIL ${list.name}: ${diffs.length} difference(s)`);
        for (const m of attribute(expected, got)) {
          console.log(`       ${m.key}: expected ${m.expected}, got ${m.actual}`);
        }
        for (const d of diffs.slice(0, 20)) {
          console.log(
            `       ${d.path}\n           expected ${d.expected}\n           got      ${d.actual}`,
          );
        }
        if (diffs.length > 20) console.log(`       ... ${diffs.length - 20} more`);
        await save(`${format}.${label}.expected.json`, expected);
        await save(`${format}.${label}.actual.json`, got);
      }
      const again = await exportProject(client, imported.projectId, format);
      const twice = await importProject(client, format, again.bytes, name);
      const third = await exportProject(client, twice.projectId, format);
      const settled = diffExports(
        canonicalExport(again.bytes, again.filename),
        canonicalExport(third.bytes, again.filename),
      );
      if (!settled.length) console.log(`  ok   ${list.name}, round-tripped twice`);
      else if (list.settles === false) {
        console.log(`  known ${list.name}, round-tripped twice: ${settled.length} line(s) differ`);
      } else {
        failures += 1;
        console.log(`  FAIL ${list.name}, round-tripped twice: the second pass changed it again`);
        for (const line of settled.slice(0, 20)) console.log(`       ${line}`);
      }
    }
  }
} catch (err) {
  failures += 1;
  console.error(err);
} finally {
  await core.stop();
}
console.log(
  `\n${failures ? `${failures} failure(s)` : 'every corpus matches its lists'}, ${secs()}`,
);
process.exit(failures ? 1 : 0);
