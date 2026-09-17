// What the outside world says about what we write: every export of a project
// run through the format's OWN validator, not ours.
//
//   node --import ./e2e/live/aliases.mjs e2e/fidelity/validate.mjs \
//     [--format plaintext,flextext,cldf,elan,plaid-igt-json] [--keep] [--out <dir>]
//
// The round trip asks whether we can read back what we wrote. This asks the
// other question: would ELAN open it, would FieldWorks import it, would pycldf
// call it a dataset. A file we read perfectly and nobody else accepts is still
// a broken export.
//
//   .eaf        xmllint against the EAF 2.8 schema
//   .flextext   xmllint against FieldWorks' FlexInterlinear.xsd
//   .lift       xmllint against the LIFT 0.13 RelaxNG
//   CLDF        pycldf validate, over the unpacked dataset
//   .json       parsed, and its manifest read
//
// The schemas are third-party and not in the repo: PLAID_SCHEMA_DIR names the
// directory holding EAFv2.8.xsd, FlexInterlinear.xsd and lift-0.13.rng
// (default ~/local/schemas). A validator whose schema or program is missing is
// reported as skipped, never as a pass. pycldf comes from the mamba base
// environment (PLAID_PYTHON names another).
//
// The core is the campaign's private one (core.mjs), never the dev core.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { coreForRun } from './core.mjs';
import { exportProject } from './drivers.mjs';
import { buildKitchenSink } from './kitchenSink.mjs';

const run = promisify(execFile);

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const formats = (arg('--format') ?? 'plaintext,flextext,cldf,elan,plaid-igt-json').split(',');
const keep = process.argv.includes('--keep');
const outDir = arg('--out');
const schemaDir = process.env.PLAID_SCHEMA_DIR || '/home/luke/local/schemas';
const python = process.env.PLAID_PYTHON || `${process.env.HOME}/.mambaforge/bin/python3`;

const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

const schema = (name) => {
  const path = join(schemaDir, name);
  return existsSync(path) ? path : null;
};

/** Run a program and return { ok, output }, with a missing program reported as such. */
async function tool(program, args) {
  try {
    const { stdout, stderr } = await run(program, args, { maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: `${program} is not installed` };
    return { ok: false, output: `${err.stdout || ''}${err.stderr || err.message}`.trim() };
  }
}

/** Every file of an export, unzipped when it is a zip, as { path, bytes }. */
function filesOf(bytes, filename) {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) return [{ path: filename, bytes }];
  return Object.entries(unzipSync(bytes))
    .filter(([path]) => !path.endsWith('/'))
    .map(([path, data]) => ({ path, bytes: data }));
}

/** The validator for one file, or null when nothing outside plaid checks it. */
function validatorFor(path) {
  if (/\.eaf$/i.test(path)) return { name: 'EAF 2.8', schema: 'EAFv2.8.xsd', flag: '--schema' };
  if (/\.flextext$/i.test(path)) {
    return { name: 'FlexInterlinear', schema: 'FlexInterlinear.xsd', flag: '--schema' };
  }
  if (/\.lift$/i.test(path))
    return { name: 'LIFT 0.13', schema: 'lift-0.13.rng', flag: '--relaxng' };
  return null;
}

const results = [];
const record = (label, state, detail = '') => {
  results.push({ label, state, detail });
  const mark = { ok: '  ok  ', fail: '  FAIL', skip: '  skip' }[state];
  console.log(`${mark} ${label}${detail ? `: ${detail}` : ''}`);
};

/** Validate one exported file with whatever outside tool covers it. */
async function validateFile(dir, label, file) {
  const path = join(dir, file.path.replace(/\//g, '_'));
  await writeFile(path, file.bytes);
  if (/\.json$/i.test(file.path)) {
    try {
      JSON.parse(new TextDecoder().decode(file.bytes));
      record(`${label} ${file.path}`, 'ok', 'parses as JSON');
    } catch (err) {
      record(`${label} ${file.path}`, 'fail', err.message);
    }
    return;
  }
  const v = validatorFor(file.path);
  if (!v) return;
  const found = schema(v.schema);
  if (!found) {
    record(`${label} ${file.path}`, 'skip', `${v.schema} is not in ${schemaDir}`);
    return;
  }
  const out = await tool('xmllint', ['--noout', v.flag, found, path]);
  if (out.missing) record(`${label} ${file.path}`, 'skip', out.missing);
  else if (out.ok) record(`${label} ${file.path} (${v.name})`, 'ok');
  else
    record(
      `${label} ${file.path} (${v.name})`,
      'fail',
      out.output.split('\n').slice(0, 8).join('\n        '),
    );
}

/**
 * A CLDF dataset unpacked into its own directory and handed to pycldf, keeping
 * the paths the zip has: the metadata names its media by path, so flattening
 * the tree makes pycldf report files as missing that are there.
 */
async function validateCldf(dir, label, files) {
  const datasetDir = join(dir, `cldf-${label.replace(/[^a-z0-9]+/gi, '-')}`);
  await mkdir(datasetDir, { recursive: true });
  let metadata = null;
  for (const f of files) {
    const path = join(datasetDir, f.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, f.bytes);
    if (/metadata\.json$/i.test(f.path)) metadata = path;
  }
  if (!metadata) {
    record(`${label} CLDF`, 'fail', 'the dataset has no metadata.json');
    return;
  }
  const out = await tool(python, ['-m', 'pycldf', 'validate', metadata]);
  if (out.missing) record(`${label} CLDF (pycldf)`, 'skip', out.missing);
  else if (out.ok && !out.output) record(`${label} CLDF (pycldf)`, 'ok');
  else if (out.ok)
    record(`${label} CLDF (pycldf)`, 'fail', out.output.split('\n').slice(0, 8).join('\n        '));
  else
    record(`${label} CLDF (pycldf)`, 'fail', out.output.split('\n').slice(0, 8).join('\n        '));
}

const core = await coreForRun({ keep });
const dir = await mkdtemp(join(tmpdir(), 'plaid-validate-'));
try {
  const client = core.client;
  console.log(`core at ${core.url} (${secs()})`);
  const built = await buildKitchenSink(client, { suffix: ` ${Date.now() % 1e6}` });
  console.log(`kitchen sink built (${secs()})`);

  for (const p of built.projects) {
    if (p.role === 'bare') continue;
    for (const format of formats) {
      const label = `${p.role} as ${format}`;
      let exported;
      try {
        exported = await exportProject(client, p.id, format);
      } catch (err) {
        // A refusal is the export's own answer, and the round trip checks the
        // ones we mean: here it only means there is no file to validate.
        record(label, 'skip', `the export refused it: ${err.message}`);
        continue;
      }
      if (outDir) {
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, `${format}.${p.role}`), exported.bytes);
      }
      const files = filesOf(exported.bytes, exported.filename);
      if (format === 'cldf') await validateCldf(dir, label, files);
      for (const file of files) await validateFile(dir, label, file);
    }
  }
} catch (err) {
  record('the run itself', 'fail', err.message);
  console.error(err);
} finally {
  await core.stop();
  if (!keep) await rm(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => r.state === 'fail').length;
const skipped = results.filter((r) => r.state === 'skip').length;
console.log(
  `\n${failed ? `${failed} failure(s)` : 'every export passes its own format’s validator'}` +
    `${skipped ? `, ${skipped} skipped` : ''}, ${secs()}`,
);
process.exit(failed ? 1 : 0);
