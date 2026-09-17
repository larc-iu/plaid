// The outside world's validators, for whatever a run has exported.
//
//   .eaf        xmllint against the EAF 2.8 schema
//   .flextext   xmllint against FieldWorks' FlexInterlinear.xsd
//   .lift       xmllint against the LIFT 0.13 RelaxNG
//   CLDF        pycldf validate, over the unpacked dataset
//   .json       parsed
//
// The schemas are third-party and not in the repo: PLAID_SCHEMA_DIR names the
// directory holding EAFv2.8.xsd, FlexInterlinear.xsd and lift-0.13.rng
// (default ~/local/schemas). A validator whose schema or program is missing is
// reported as skipped, never as a pass. pycldf comes from the mamba base
// environment (PLAID_PYTHON names another interpreter).

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';

const run = promisify(execFile);

const SCHEMA_DIR = process.env.PLAID_SCHEMA_DIR || `${process.env.HOME}/local/schemas`;
const PYTHON = process.env.PLAID_PYTHON || `${process.env.HOME}/.mambaforge/bin/python3`;

const schemaPath = (name) => {
  const path = join(SCHEMA_DIR, name);
  return existsSync(path) ? path : null;
};

/** Run a program and return { ok, output }, with a missing program reported as such. */
async function tool(program, args) {
  try {
    const { stdout, stderr } = await run(program, args, { maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: `${program} is not installed` };
    return { ok: false, output: `${err.stdout || ''}${err.stderr || err.message}`.trim() };
  }
}

/** Every file of an export, unzipped when it is a zip, as { path, bytes }. */
export function filesOf(bytes, filename) {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) return [{ path: filename, bytes }];
  return Object.entries(unzipSync(bytes))
    .filter(([path]) => !path.endsWith('/'))
    .map(([path, data]) => ({ path, bytes: data }));
}

/** The validator for one file, or null when nothing outside plaid checks it. */
const validatorFor = (path) => {
  if (/\.eaf$/i.test(path)) return { name: 'EAF 2.8', schema: 'EAFv2.8.xsd', flag: '--schema' };
  if (/\.flextext$/i.test(path)) {
    return { name: 'FlexInterlinear', schema: 'FlexInterlinear.xsd', flag: '--schema' };
  }
  if (/\.lift$/i.test(path)) {
    return { name: 'LIFT 0.13', schema: 'lift-0.13.rng', flag: '--relaxng' };
  }
  return null;
};

const clip = (output) => output.split('\n').slice(0, 8).join('\n        ');

/**
 * Validate one export. `dir` is scratch space the files are written into.
 *
 * @returns {Promise<Array<{label, state: 'ok'|'fail'|'skip', detail}>>}
 */
export async function validateExport(dir, label, format, exported) {
  const out = [];
  const files = filesOf(exported.bytes, exported.filename);
  const scratch = join(dir, label.replace(/[^a-z0-9]+/gi, '-'));
  await mkdir(scratch, { recursive: true });
  if (format === 'cldf') out.push(await validateCldf(scratch, label, files));
  for (const file of files) {
    const one = await validateFile(scratch, label, file);
    if (one) out.push(one);
  }
  return out.filter(Boolean);
}

async function validateFile(dir, label, file) {
  const path = join(dir, file.path.replace(/\//g, '_'));
  await writeFile(path, file.bytes);
  if (/\.json$/i.test(file.path)) {
    try {
      JSON.parse(new TextDecoder().decode(file.bytes));
      return { label: `${label} ${file.path}`, state: 'ok', detail: 'parses as JSON' };
    } catch (err) {
      return { label: `${label} ${file.path}`, state: 'fail', detail: err.message };
    }
  }
  const v = validatorFor(file.path);
  if (!v) return null;
  const schema = schemaPath(v.schema);
  if (!schema) {
    return {
      label: `${label} ${file.path}`,
      state: 'skip',
      detail: `${v.schema} is not in ${SCHEMA_DIR}`,
    };
  }
  const result = await tool('xmllint', ['--noout', v.flag, schema, path]);
  const at = `${label} ${file.path} (${v.name})`;
  if (result.missing) return { label: at, state: 'skip', detail: result.missing };
  return result.ok
    ? { label: at, state: 'ok', detail: '' }
    : { label: at, state: 'fail', detail: clip(result.output) };
}

/**
 * A CLDF dataset unpacked into its own directory and handed to pycldf, keeping
 * the paths the zip has: the metadata names its media by path, so flattening
 * the tree makes pycldf report files as missing that are there.
 */
async function validateCldf(dir, label, files) {
  const datasetDir = join(dir, 'cldf');
  await mkdir(datasetDir, { recursive: true });
  let metadata = null;
  for (const f of files) {
    const path = join(datasetDir, f.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, f.bytes);
    if (/metadata\.json$/i.test(f.path)) metadata = path;
  }
  const at = `${label} CLDF (pycldf)`;
  if (!metadata) return { label: at, state: 'fail', detail: 'the dataset has no metadata.json' };
  const result = await tool(PYTHON, ['-m', 'pycldf', 'validate', metadata]);
  if (result.missing) return { label: at, state: 'skip', detail: result.missing };
  // pycldf leaves with 0 and a warning for some findings, so anything it says
  // at all is a finding: a clean dataset validates silently.
  return result.ok && !result.output
    ? { label: at, state: 'ok', detail: '' }
    : { label: at, state: 'fail', detail: clip(result.output) };
}
