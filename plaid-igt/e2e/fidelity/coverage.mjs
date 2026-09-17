// Build the kitchen sink on a private core and check it holds every feature.
//
//   node --import ./e2e/live/aliases.mjs e2e/fidelity/coverage.mjs [--out <dir>] [--keep]
//
// Fails when a feature in src/test/fidelity/catalog.js appears nowhere in the
// kitchen-sink projects (the builder does not make it), or when the bare
// project, which holds nothing but setup, shows a feature not marked `bare`
// (the detector is true of too much). `--out` writes each project's snapshot
// there as JSON, for reading what the builder made. `--keep` leaves the
// private core's data directory in place.
//
// Set PLAID_FIDELITY_CORE_URL and PLAID_FIDELITY_TOKEN to run against a core
// already started with `node e2e/fidelity/core.mjs` (see core.mjs).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FEATURES, detectFeatures } from '../../src/test/fidelity/catalog.js';
import { coreForRun } from './core.mjs';
import { buildKitchenSink } from './kitchenSink.mjs';
import { snapshotProject, stableStringify } from './snapshot.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const outDir = arg('--out');
const keep = process.argv.includes('--keep');

const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const core = await coreForRun({ keep });
let failed = false;
try {
  console.log(`core at ${core.url} (${secs()})`);
  const built = await buildKitchenSink(core.client, { suffix: ` ${Date.now() % 1e6}` });
  console.log(`kitchen sink built (${secs()})`);

  const snaps = {};
  for (const p of built.projects) {
    snaps[p.role] = await snapshotProject(core.client, p.id);
    if (outDir) {
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, `${p.role}.json`), JSON.stringify(snaps[p.role], null, 2));
    }
  }
  console.log(`snapshots read (${secs()})`);

  const inSink = detectFeatures([snaps.main, snaps.blacklist]);
  const inBare = detectFeatures([snaps.bare]);

  const missing = FEATURES.filter((f) => inSink.get(f.key) === 0);
  const leaky = FEATURES.filter((f) => !f.bare && inBare.get(f.key) > 0);
  const bareMissing = FEATURES.filter((f) => f.bare && inBare.get(f.key) === 0);

  const width = Math.max(...FEATURES.map((f) => f.key.length));
  for (const f of FEATURES) {
    const n = inSink.get(f.key);
    console.log(
      `${n === 0 ? 'MISSING' : '       '} ${f.key.padEnd(width)} ${String(n).padStart(4)}`,
    );
  }
  if (missing.length) {
    failed = true;
    console.log(`\n${missing.length} feature(s) the kitchen sink does not hold:`);
    for (const f of missing) console.log(`  ${f.key}: ${f.what}`);
  }
  if (leaky.length) {
    failed = true;
    console.log(`\n${leaky.length} detector(s) counting something in the bare project:`);
    for (const f of leaky) console.log(`  ${f.key}: ${inBare.get(f.key)}`);
  }
  if (bareMissing.length) {
    failed = true;
    console.log(`\n${bareMissing.length} feature(s) marked bare that setup did not make:`);
    for (const f of bareMissing) console.log(`  ${f.key}`);
  }

  // Reading twice must give the same value, or no comparison built on it means anything.
  const again = await snapshotProject(core.client, built.projects[0].id);
  if (stableStringify(again) !== stableStringify(snaps.main)) {
    failed = true;
    console.log('\nsnapshot is not deterministic: two reads of the main project differ');
  }

  console.log(
    `\n${FEATURES.length - missing.length}/${FEATURES.length} features covered, ${secs()} in all`,
  );
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await core.stop();
}
process.exit(failed ? 1 : 0);
