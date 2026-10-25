// What the outside world says about what we write: every export of the kitchen
// sink run through the format's OWN validator, not ours.
//
//   node --import ./e2e/live/aliases.mjs e2e/fidelity/validate.mjs \
//     [--format plaintext,flextext,cldf,elan,latex,plaid-igt-json] [--keep] [--out <dir>]
//
// The round trip asks whether we can read back what we wrote. This asks the
// other question: would ELAN open it, would FieldWorks import it, would pycldf
// call it a dataset. A file we read perfectly and nobody else accepts is still
// a broken export. Which validator covers which file, and where the schemas
// come from, is ./validators.mjs.
//
// A project is validated only in the formats the kitchen sink gives it. An
// export refusal refusals.mjs expects is a skip, any other refusal is a
// failure, and so is an export that goes through where the list expects a
// refusal.
//
// The core is the campaign's private one (core.mjs), never the dev core.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreForRun } from './core.mjs';
import { exportProject, formatIdOf } from './drivers.mjs';
import { buildKitchenSink } from './kitchenSink.mjs';
import { expectedExportRefusal } from './refusals.mjs';
import { validateExport } from './validators.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const formats = (arg('--format') ?? 'plaintext,flextext,cldf,elan,latex,plaid-igt-json').split(',');
const keep = process.argv.includes('--keep');
const outDir = arg('--out');

const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

const results = [];
const record = ({ label, state, detail }) => {
  results.push({ label, state, detail });
  const mark = { ok: '  ok  ', fail: '  FAIL', skip: '  skip' }[state];
  console.log(`${mark} ${label}${detail ? `: ${detail}` : ''}`);
};

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
      if (p.formats && !p.formats.includes(formatIdOf(format))) continue;
      const label = `${p.role} as ${format}`;
      const expected = expectedExportRefusal(p.role, formatIdOf(format));
      let exported;
      try {
        exported = await exportProject(client, p.id, format);
      } catch (err) {
        const state = expected?.message.test(err.message) ? 'skip' : 'fail';
        record({ label, state, detail: `the export refused it: ${err.message}` });
        continue;
      }
      if (expected) {
        record({
          label,
          state: 'fail',
          detail: 'the export went through, refusals.mjs expects it refused',
        });
        continue;
      }
      if (outDir) {
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, `${format}.${p.role}`), exported.bytes);
      }
      for (const result of await validateExport(dir, label, format, exported)) record(result);
    }
  }
} catch (err) {
  record({ label: 'the run itself', state: 'fail', detail: err.message });
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
