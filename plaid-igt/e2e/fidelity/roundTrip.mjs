// Round trips through the formats that can read back what they write, checked
// against each format's loss list.
//
//   node --import ./e2e/live/aliases.mjs e2e/fidelity/roundTrip.mjs \
//     [--format native,cldf,elan] [--out <dir>] [--keep]
//
// The kitchen sink is built on a private core (core.mjs). Each of its projects
// but the bare one is exported with every option on, the export is imported as
// a new project the way the import screen would, and both projects are
// snapshotted from the server. The source snapshot is edited into what the
// format's loss list says should come back (src/test/fidelity/expect/), and
// every place the import's snapshot still differs is printed, with the catalog
// features whose counts moved. Any difference fails the run: either the format
// does not do what its list says, or the list says it wrong.
//
// When an ELAN import refuses the project's own export (the files differ in
// tier structure), that refusal is reported as a failure and each document is
// then round-tripped on its own, so the rest of what ELAN carries is still
// checked.
//
// `--out` writes each side's finalized snapshot and the raw export there.
// PLAID_FIDELITY_CORE_URL and PLAID_FIDELITY_TOKEN point it at a running core
// (see core.mjs).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attribute, diffSnapshots } from '../../src/test/fidelity/compare.js';
import { expectRoundTrip } from '../../src/test/fidelity/expect/index.js';
import cldfList from '../../src/test/fidelity/formats/cldf.js';
import elanList from '../../src/test/fidelity/formats/elan.js';
import nativeList from '../../src/test/fidelity/formats/native.js';
import { coreForRun } from './core.mjs';
import { exportDocument, exportProject, importProject } from './drivers.mjs';
import { canonicalExport, diffExports } from './fixedPoint.mjs';
import { buildKitchenSink } from './kitchenSink.mjs';
import { snapshotProject } from './snapshot.mjs';

const LISTS = { native: nativeList, cldf: cldfList, elan: elanList };

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const formats = (arg('--format') ?? 'native,cldf,elan').split(',');
const outDir = arg('--out');
const keep = process.argv.includes('--keep');
for (const f of formats) if (!LISTS[f]) throw new Error(`unknown format ${f}`);

const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

const statusOf = (list, key) => {
  const e = list.features[key];
  if (e.carried === true) return 'carried';
  if (e.carried === 'changed') return 'changed';
  return `lost (${e.kind})`;
};

async function save(name, value) {
  if (!outDir) return;
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, name);
  if (value instanceof Uint8Array) await writeFile(path, value);
  else await writeFile(path, JSON.stringify(value, null, 2));
}

/** Compare one import against its source and print the report. Returns the failure count. */
function report(label, list, source, actual, bare) {
  const { expected, actual: got } = expectRoundTrip({ list, source, actual, bare });
  const diffs = diffSnapshots(expected, got);
  const moved = attribute(expected, got);
  if (!diffs.length) {
    console.log(`  ok   ${label}`);
    return { failures: 0, expected, actual: got };
  }
  console.log(`  FAIL ${label}: ${diffs.length} difference(s)`);
  for (const m of moved) {
    console.log(
      `       ${m.key} [${statusOf(list, m.key)}]: expected ${m.expected}, got ${m.actual}`,
    );
  }
  if (!moved.length) console.log('       (no catalog count moved: the catalog does not see this)');
  for (const d of diffs) {
    console.log(
      `       ${d.path}\n           expected ${d.expected}\n           got      ${d.actual}`,
    );
  }
  return { failures: 1, expected, actual: got };
}

/** Compare a second export with the first. Returns the failure count. */
function fixedPoint(label, first, second) {
  const diffs = diffExports(
    canonicalExport(first.bytes, first.filename),
    canonicalExport(second.bytes, first.filename),
  );
  if (!diffs.length) {
    console.log(`  ok   ${label}, exported again`);
    return 0;
  }
  console.log(`  FAIL ${label}, exported again: the second export differs from the first`);
  for (const line of diffs) console.log(`       ${line}`);
  return 1;
}

const core = await coreForRun({ keep });
let failures = 0;
try {
  const client = core.client;
  console.log(`core at ${core.url} (${secs()})`);
  const built = await buildKitchenSink(client, { suffix: ` ${Date.now() % 1e6}` });
  const bareId = built.projects.find((p) => p.role === 'bare').id;
  const bare = await snapshotProject(client, bareId);
  const sources = built.projects.filter((p) => p.role !== 'bare');
  const sourceSnaps = new Map();
  for (const p of sources) sourceSnaps.set(p.role, await snapshotProject(client, p.id));
  console.log(`kitchen sink built and read (${secs()})`);

  for (const format of formats) {
    const list = LISTS[format];
    console.log(`\n${list.name}`);
    for (const p of sources) {
      const source = sourceSnaps.get(p.role);
      const label = `${p.role} project`;
      const exported = await exportProject(client, p.id, format);
      await save(`${format}.${p.role}.export`, exported.bytes);
      for (const w of exported.warnings) console.log(`       export warning: ${w}`);

      let imported;
      try {
        imported = await importProject(client, format, exported.bytes, p.name);
      } catch (err) {
        failures += 1;
        console.log(`  FAIL ${label}: the import refused the export: ${err.message}`);
        if (format !== 'elan') continue;
        failures += await perDocument(client, list, p, source, bare);
        continue;
      }
      for (const w of imported.warnings) console.log(`       import warning: ${w}`);
      for (const n of imported.notes) console.log(`       note: ${n}`);
      const actual = await snapshotProject(client, imported.projectId);
      const out = report(label, list, source, actual, bare);
      failures += out.failures;
      await save(`${format}.${p.role}.expected.json`, out.expected);
      await save(`${format}.${p.role}.actual.json`, out.actual);
      const again = await exportProject(client, imported.projectId, format);
      await save(`${format}.${p.role}.export2`, again.bytes);
      failures += fixedPoint(label, exported, again);
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
  `\n${failures ? `${failures} failure(s)` : 'all round trips match their lists'}, ${secs()}`,
);
process.exit(failures ? 1 : 0);

// Each document exported and imported on its own, compared with the source
// narrowed to that document.
async function perDocument(client, list, p, source, bare) {
  let failed = 0;
  const docs = await client.projects.listDocuments(p.id);
  const keys = source.documents.map((d) => d.key);
  // listDocuments order is the order snapshot keys were numbered in.
  const counts = new Map();
  for (const ref of docs) {
    const n = (counts.get(ref.name) ?? 0) + 1;
    counts.set(ref.name, n);
    const key = `${ref.name}#${n}`;
    if (!keys.includes(key)) throw new Error(`no document ${key} in the source snapshot`);
    const label = `${p.role} project, document ${key}`;
    const exported = await exportDocument(client, p.id, ref.id, list.id);
    for (const w of exported.warnings) console.log(`       export warning: ${w}`);
    let imported;
    try {
      imported = await importProject(client, list.id, exported.bytes, p.name);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${label}: the import refused the export: ${err.message}`);
      continue;
    }
    for (const w of imported.warnings) console.log(`       import warning: ${w}`);
    for (const n of imported.notes) console.log(`       note: ${n}`);
    const narrowed = narrowTo(source, key);
    const actual = await snapshotProject(client, imported.projectId);
    failed += report(label, list, narrowed, actual, bare).failures;
    const again = await exportDocument(
      client,
      imported.projectId,
      (await client.projects.listDocuments(imported.projectId))[0].id,
      list.id,
    );
    failed += fixedPoint(label, exported, again);
  }
  return failed;
}

// The source as a project holding one document: the others are dropped with
// everything in them, and an entry's promoted example into a dropped document
// is dropped too (it is exported only with the document it points into).
function narrowTo(source, key) {
  const s = structuredClone(source);
  const kept = s.documents.find((d) => d.key === key);
  s.documents = [kept];
  for (const v of s.vocabularies || []) {
    for (const it of v.items) {
      const ex = it.metadata?.examples;
      if (!Array.isArray(ex)) continue;
      it.metadata.examples = ex.filter(
        (e) => !(e && typeof e === 'object' && 'document' in e) || e.document === key,
      );
      if (!it.metadata.examples.length) delete it.metadata.examples;
    }
  }
  return s;
}
