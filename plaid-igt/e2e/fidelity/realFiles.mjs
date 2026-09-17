// The round trip on REAL corpora: every .fwbackup in a directory is imported
// with the real FLEx importer, and the project it makes goes through the same
// round trip and the same loss list as the kitchen sink, and out through the
// outside world's validators (./validators.mjs).
//
//   node --import ./e2e/live/aliases.mjs e2e/fidelity/realFiles.mjs \
//     [--dir <path>] [--file <path>] [--eaf <dir>] [--format native,cldf,elan] \
//     [--validate] [--docs N] [--keep] [--out <dir>]
//
// --eaf imports a directory of .eaf files the way the ELAN import screen does,
// as one batch, instead of reading .fwbackup files, and --cldf imports one
// CLDF dataset, ours or somebody else's. Someone's real recordings are their
// own: point the run at a directory, never copy the files into the repo.
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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
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
import { validateExport } from './validators.mjs';
import { canonicalExport, diffExports } from './fixedPoint.mjs';
import { snapshotProject } from './snapshot.mjs';

const LISTS = { native: nativeList, cldf: cldfList, elan: elanList };
const DEFAULT_DIR = '/home/luke/Downloads/fwsamples';
// Only the archive has to come back whole from a real corpus (user,
// 2026-09-17: round trips other than the native one may have warts). The other
// formats are still run, and what they lose is still printed, but their lists
// are written against the kitchen sink and a real corpus has shapes it does
// not: those differences are reported, not failed.
const MUST_MATCH = new Set(['native']);

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const formats = (arg('--format') ?? 'native').split(',');
const docCap = Number(arg('--docs') ?? 0);
const outDir = arg('--out');
const keep = process.argv.includes('--keep');
const alsoValidate = process.argv.includes('--validate');
const eafDir = arg('--eaf');
const cldfFile = arg('--cldf');
for (const f of formats) if (!LISTS[f]) throw new Error(`unknown format ${f}`);

const one = arg('--file');
const dir = arg('--dir', DEFAULT_DIR);
const backups =
  eafDir || cldfFile
    ? []
    : one
      ? [one]
      : readdirSync(dir)
          .filter((f) => f.toLowerCase().endsWith('.fwbackup'))
          .map((f) => join(dir, f))
          .sort((a, b) => statSync(a).size - statSync(b).size);
if (!eafDir && !cldfFile && !backups.length) throw new Error(`no .fwbackup files in ${dir}`);

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

/** A directory of .eaf files zipped the way an export writes them, for the batch import. */
function eafBatch(path) {
  const files = readdirSync(path).filter((f) => /\.(eaf|wav|mp3|m4a|mp4|wave)$/i.test(f));
  if (!files.some((f) => /\.eaf$/i.test(f))) throw new Error(`no .eaf files in ${path}`);
  const entries = {};
  for (const f of files) entries[f] = new Uint8Array(readFileSync(join(path, f)));
  return { bytes: zipSync(entries), count: files.filter((f) => /\.eaf$/i.test(f)).length };
}

const core = await coreForRun({ keep });
const scratch = await mkdtemp(join(tmpdir(), 'plaid-real-'));
let failures = 0;
let known = 0;
try {
  const client = core.client;
  console.log(`core at ${core.url} (${secs()})`);
  const bareId = await bareProject(client, `Bare ${Date.now() % 1e6}`);
  const bare = await snapshotProject(client, bareId);

  for (const path of eafDir ? [eafDir] : cldfFile ? [cldfFile] : backups) {
    const label = path
      .split('/')
      .filter(Boolean)
      .pop()
      .replace(/\.(fwbackup|zip)$/i, '');
    const name = `${label} ${Date.now() % 1e6}`;
    let source;
    let projectId;
    try {
      if (cldfFile) {
        // Somebody else's dataset, read by our own CLDF import: the project it
        // makes is the source the round trips start from.
        const done = await importProject(client, 'cldf', new Uint8Array(readFileSync(path)), name);
        projectId = done.projectId;
        console.log(`\n${label} (${secs()})`);
        for (const w of done.warnings.slice(0, 5)) console.log(`       import warning: ${w}`);
        if (done.warnings.length > 5) {
          console.log(`       ... ${done.warnings.length - 5} more import warnings`);
        }
      } else if (eafDir) {
        const batch = eafBatch(path);
        const done = await importProject(client, 'elan', batch.bytes, name);
        projectId = done.projectId;
        console.log(`\n${label}: ${batch.count} .eaf file(s) (${secs()})`);
        for (const w of done.warnings.slice(0, 5)) console.log(`       import warning: ${w}`);
        for (const n of done.notes) console.log(`       note: ${n}`);
      } else {
        const done = await importBackup(client, path, name);
        projectId = done.projectId;
        console.log(
          `\n${label}: ${JSON.stringify(done.stats)}${docCap ? ` (${docCap} smallest imported)` : ''} (${secs()})`,
        );
        for (const w of done.warnings.slice(0, 5)) console.log(`       import warning: ${w}`);
        if (done.warnings.length > 5) {
          console.log(`       ... ${done.warnings.length - 5} more import warnings`);
        }
      }
      source = await snapshotProject(client, projectId);
    } catch (err) {
      failures += 1;
      console.log(`\n${label}\n  FAIL the import: ${err.message}`);
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
      if (alsoValidate) {
        for (const r of await validateExport(scratch, `${label} as ${format}`, format, exported)) {
          if (r.state === 'fail') failures += 1;
          const mark = { ok: '  ok  ', fail: '  FAIL', skip: '  skip' }[r.state];
          console.log(`${mark} ${r.label}${r.detail ? `: ${r.detail}` : ''}`);
        }
      }
      const actual = await snapshotProject(client, imported.projectId);
      const { expected, actual: got } = expectRoundTrip({ list, source, actual, bare });
      const diffs = diffSnapshots(expected, got);
      const strict = MUST_MATCH.has(format);
      if (!diffs.length) console.log(`  ok   ${list.name}`);
      else {
        if (strict) failures += 1;
        else known += 1;
        console.log(`  ${strict ? 'FAIL' : 'known'} ${list.name}: ${diffs.length} difference(s)`);
        for (const m of attribute(expected, got)) {
          console.log(`       ${m.key}: expected ${m.expected}, got ${m.actual}`);
        }
        for (const d of diffs.slice(0, strict ? 20 : 3)) {
          console.log(
            `       ${d.path}\n           expected ${d.expected}\n           got      ${d.actual}`,
          );
        }
        const shown = strict ? 20 : 3;
        if (diffs.length > shown) console.log(`       ... ${diffs.length - shown} more`);
        await save(`${format}.${label}.expected.json`, expected);
        await save(`${format}.${label}.actual.json`, got);
      }
      let again;
      let third;
      try {
        again = await exportProject(client, imported.projectId, format);
        const twice = await importProject(client, format, again.bytes, name);
        third = await exportProject(client, twice.projectId, format);
      } catch (err) {
        // The second pass refusing is the format's own answer about what it
        // made, which the round trip above has already reported on.
        if (strict) failures += 1;
        console.log(
          `  ${strict ? 'FAIL' : 'known'} ${list.name}, round-tripped twice: ${err.message}`,
        );
        continue;
      }
      const settled = diffExports(
        canonicalExport(again.bytes, again.filename),
        canonicalExport(third.bytes, again.filename),
      );
      if (!settled.length) console.log(`  ok   ${list.name}, round-tripped twice`);
      else if (list.settles === false || !strict) {
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
  if (!keep) await rm(scratch, { recursive: true, force: true });
}
console.log(
  `\n${failures ? `${failures} failure(s)` : 'every corpus comes back whole from the archive'}` +
    `${known ? `, ${known} known difference(s) in the other formats` : ''}, ${secs()}`,
);
process.exit(failures ? 1 : 0);
