// An import stopped partway and picked up again has to end where an
// uninterrupted one ends.
//
//   node --import ./e2e/live/aliases.mjs e2e/fidelity/resume.mjs \
//     [--format native,cldf,elan] [--stops 1,3,8,20,50] [--keep]
//
// A person closes the tab, loses the network or presses Stop, and comes back
// to the unfinished-import screen (src/import/resume.js). What that screen
// does is run the same engine over the same file again, on the project that is
// already there, and an engine is meant to ask the DATA what is already in
// rather than keep a tally. So the test is: import the file straight through,
// import it again stopping after the Nth write, resume, and compare the two
// projects. Anything different is work the resume did twice or not at all.
//
// The comparison is between two imports of the same file, so the snapshots are
// compared as they are: no loss list, no strips, nothing to allow for except
// the import's own bookkeeping.
//
// The core is the campaign's private one (core.mjs), never the dev core.

import { clone, diffSnapshots } from '../../src/test/fidelity/compare.js';
import { finalize } from '../../src/test/fidelity/expect/snap.js';
import cldfList from '../../src/test/fidelity/formats/cldf.js';
import elanList from '../../src/test/fidelity/formats/elan.js';
import nativeList from '../../src/test/fidelity/formats/native.js';
import { coreForRun } from './core.mjs';
import { exportProject, importProject } from './drivers.mjs';
import { buildKitchenSink } from './kitchenSink.mjs';
import { snapshotProject } from './snapshot.mjs';

const LISTS = { native: nativeList, cldf: cldfList, elan: elanList };

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const formats = (arg('--format') ?? 'native,cldf,elan').split(',');
// By default the stop points are spread over however many times THIS import
// asks whether to keep going, which the straight run below counts: a fixed
// list either stops in the same few places every time or runs off the end.
const chosen = arg('--stops');
const keep = process.argv.includes('--keep');
for (const f of formats) if (!LISTS[f]) throw new Error(`unknown format ${f}`);

const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

/** Stops the import on the nth time the engine asks whether to keep going. */
const stopAfter = (n) => {
  let asked = 0;
  return () => (asked += 1) > n;
};

/**
 * A snapshot with the project's name and the import's own bookkeeping off, so
 * two imports of one file are comparable. `finalize` then renumbers keys, which
 * two projects holding the same content agree on.
 */
function comparable(snapshot, list) {
  const s = clone(snapshot);
  delete s.name;
  const stamps = list.stamps || {};
  const cfg = s.config?.igt;
  for (const k of stamps.projectConfig || []) if (cfg) delete cfg[k];
  for (const d of s.documents || []) {
    for (const k of stamps.documentMetadata || []) delete d.metadata[k];
    for (const t of d.tokens) for (const k of stamps.tokenMetadata || []) delete t.metadata[k];
  }
  for (const v of s.vocabularies || []) {
    for (const it of v.items) for (const k of stamps.itemMetadata || []) delete it.metadata[k];
  }
  for (const d of s.documents || []) for (const sp of d.spans) delete sp.order;
  return finalize(s);
}

const core = await coreForRun({ keep });
let failures = 0;
try {
  const client = core.client;
  console.log(`core at ${core.url} (${secs()})`);
  const built = await buildKitchenSink(client, { suffix: ` ${Date.now() % 1e6}` });
  const main = built.projects.find((p) => p.role === 'main');
  console.log(`kitchen sink built (${secs()})`);

  for (const format of formats) {
    const list = LISTS[format];
    console.log(`\n${list.name}`);
    let exported;
    try {
      exported = await exportProject(client, main.id, format);
    } catch (err) {
      console.log(`  skip ${list.name}: the export refused the project: ${err.message}`);
      continue;
    }
    let whole;
    let asked = 0;
    try {
      const straight = await importProject(client, format, exported.bytes, main.name, () => {
        asked += 1;
        return false;
      });
      whole = comparable(await snapshotProject(client, straight.projectId), list);
    } catch (err) {
      failures += 1;
      console.log(`  FAIL ${list.name}: the uninterrupted import failed: ${err.message}`);
      continue;
    }

    const stops = chosen
      ? chosen.split(',').map(Number)
      : [...new Set([1, ...[0.25, 0.5, 0.75, 0.9].map((f) => Math.max(1, Math.round(asked * f)))])];
    console.log(`  (the engine asks ${asked} times; stopping after ${stops.join(', ')})`);
    for (const n of stops) {
      const label = `stopped after write ${n}`;
      let run;
      try {
        run = await importProject(client, format, exported.bytes, main.name, stopAfter(n));
      } catch (err) {
        failures += 1;
        console.log(`  FAIL ${label}: the import failed rather than stopped: ${err.message}`);
        continue;
      }
      if (!run.cancelled) {
        // The import was already over by then, which the later stop points
        // will be too: say so rather than pass silently.
        console.log(`  ok   ${label}: the import had already finished`);
        continue;
      }
      try {
        await run.resume();
      } catch (err) {
        failures += 1;
        console.log(`  FAIL ${label}: the resume failed: ${err.message}`);
        continue;
      }
      const resumed = comparable(await snapshotProject(client, run.projectId), list);
      const diffs = diffSnapshots(whole, resumed);
      if (!diffs.length) {
        console.log(`  ok   ${label}, resumed`);
        continue;
      }
      failures += 1;
      console.log(`  FAIL ${label}, resumed: ${diffs.length} difference(s) from a whole import`);
      for (const d of diffs.slice(0, 10)) {
        console.log(
          `       ${d.path}\n           whole   ${d.expected}\n           resumed ${d.actual}`,
        );
      }
      if (diffs.length > 10) console.log(`       ... ${diffs.length - 10} more`);
    }
    console.log(`(${secs()})`);
  }
} catch (err) {
  failures += 1;
  console.error(err);
} finally {
  await core.stop();
}
console.log(
  `\n${failures ? `${failures} failure(s)` : 'every resumed import matches a whole one'}, ${secs()}`,
);
process.exit(failures ? 1 : 0);
