// A native archive of a document whose text keeps a character decomposed,
// because a token begins or ends inside it, imports, and the project's own
// archive imports back identical (Luke, 2026-10-09: the native archive round
// trips identically, and composing never leaves a token with no text).
//
//   node --import ./e2e/live/aliases.mjs e2e/fidelity/composedArchive.mjs [--keep]
//
// The glued project then goes out as CLDF and as ELAN and comes back as a
// new project with the mark still a word of its own on its own letter: those
// importers read a line decomposed where a word begins inside a character,
// and create the text with its tokens' edges.
//
// fixtures/mark-word-glued.zip is an archive written decomposed with a tone
// mark that is a word of its own right after "ka" (what a text edit makes of
// "ka, a space, the mark, ma" when the space goes). fixtures/mark-word-spaced.zip has the space,
// which the text edit then deletes on the server. Both came from the H12-IO
// hunt (polish campaign, 2026-10-09).
//
// The core is a private one (core.mjs), never the dev core.

import { readFile } from 'node:fs/promises';
import { cpLength, cpIndexOf } from '@larc-iu/plaid-client';
import { clone, diffSnapshots } from '../../src/test/fidelity/compare.js';
import { finalize } from '../../src/test/fidelity/expect/snap.js';
import nativeList from '../../src/test/fidelity/formats/native.js';
import { coreForRun } from './core.mjs';
import { exportProject, importProject } from './drivers.mjs';
import { snapshotProject } from './snapshot.mjs';

const keep = process.argv.includes('--keep');
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

// Two imports of one archive compared as they are, less the project's name
// and the import's own stamps (as resume.mjs compares them).
function comparable(snapshot) {
  const s = clone(snapshot);
  delete s.name;
  const stamps = nativeList.stamps || {};
  const cfg = s.config?.igt;
  for (const k of stamps.projectConfig || []) if (cfg) delete cfg[k];
  for (const d of s.documents || []) {
    for (const k of stamps.documentMetadata || []) delete d.metadata[k];
    for (const t of d.tokens) for (const k of stamps.tokenMetadata || []) delete t.metadata[k];
    for (const sp of d.spans) delete sp.order;
  }
  for (const v of s.vocabularies || []) {
    for (const it of v.items) for (const k of stamps.itemMetadata || []) delete it.metadata[k];
  }
  return finalize(s);
}

let failures = 0;
const fail = (what) => {
  failures += 1;
  console.log(`  FAIL ${what}`);
};

// The text of the document holding "ka" and its mark, and every token on it.
async function markWord(client, projectId) {
  for (const ref of await client.projects.listDocuments(projectId)) {
    const raw = await client.documents.get(ref.id, true);
    for (const tl of raw.textLayers || []) {
      const body = tl.text?.body ?? '';
      if (cpIndexOf(body, 'ka') < 0 || !body.includes('\u0301')) continue;
      const tokens = (tl.tokenLayers || []).flatMap((l) =>
        (l.tokens || []).map((t) => ({
          ...t,
          layer: l.name,
          parent: l.parentTokenLayerId ?? null,
        })),
      );
      return { docId: ref.id, text: tl.text, tokens };
    }
  }
  return null;
}

// Whether the project's text keeps "ka" and its mark apart, the mark a token
// of its own, and no token with no text. Says what is wrong, else nothing.
async function markKept(client, label, projectId) {
  const found = await markWord(client, projectId);
  if (!found) return fail(`${label}: no text with the mark word`);
  const zero = found.tokens.filter((t) => t.parent && t.begin === t.end);
  if (zero.length) fail(`${label}: ${zero.length} token(s) left with no text`);
  const at = cpIndexOf(found.text.body, 'ka\u0301');
  if (at < 0) fail(`${label}: "ka" and its mark are not kept apart in the stored text`);
  else if (!found.tokens.some((t) => t.begin === at + 2 && t.end === at + 3)) {
    fail(`${label}: the mark has no token of its own`);
  }
  return found;
}

// The project out as `format` and in again as a new one, the mark kept.
async function throughFormat(client, label, projectId, format) {
  const before = failures;
  const exported = await exportProject(client, projectId, format);
  const again = await importProject(client, format, exported.bytes, `${label} ${format}`);
  await markKept(client, `${label} through ${format}`, again.projectId);
  if (failures === before) {
    console.log(`  ok   ${label}: out as ${format} and in again, the mark kept (${secs()})`);
  }
}

async function roundTrip(client, label, projectId) {
  const before = await markKept(client, label, projectId);
  if (!before) return;
  const exported = await exportProject(client, projectId, 'native');
  const again = await importProject(client, 'native', exported.bytes, `${label} again`);
  const diffs = diffSnapshots(
    comparable(await snapshotProject(client, projectId)),
    comparable(await snapshotProject(client, again.projectId)),
  );
  if (diffs.length) {
    fail(`${label}: its archive imports back with ${diffs.length} difference(s)`);
    for (const d of diffs.slice(0, 10)) {
      console.log(
        `       ${d.path}\n           before ${d.expected}\n           after  ${d.actual}`,
      );
    }
    return;
  }
  console.log(`  ok   ${label}: imported, and its archive imports back identical (${secs()})`);
}

const core = await coreForRun({ keep });
try {
  const client = core.client;
  console.log(`core at ${core.url} (${secs()})`);

  console.log('\nan archive with a tone mark glued to the word before it');
  try {
    const glued = await importProject(
      client,
      'native',
      await fixture('mark-word-glued.zip'),
      'Glued',
    );
    await roundTrip(client, 'glued archive', glued.projectId);
    for (const format of ['cldf', 'elan']) {
      try {
        await throughFormat(client, 'glued archive', glued.projectId, format);
      } catch (err) {
        fail(`glued archive through ${format}: ${err.message}`);
      }
    }
  } catch (err) {
    fail(`glued archive: ${err.message}`);
  }

  console.log('\na text edit that glues the mark, then the round trip');
  try {
    const spaced = await importProject(
      client,
      'native',
      await fixture('mark-word-spaced.zip'),
      'Spaced',
    );
    const found = await markWord(client, spaced.projectId);
    const at = cpIndexOf(found.text.body, 'ka \u0301');
    if (at < 0) throw new Error('no "ka", a space and the mark in the text');
    const res = await client.texts.edit(
      found.text.id,
      [{ type: 'delete', index: at + 2, value: 1 }],
      undefined,
      { base: found.text.digest },
    );
    if (cpLength(res.body) !== cpLength(found.text.body) - 1) {
      fail('text edit: the body did not lose just the space');
    }
    await roundTrip(client, 'edited text', spaced.projectId);
  } catch (err) {
    fail(`edited text: ${err.message}`);
  }
} catch (err) {
  failures += 1;
  console.error(err);
} finally {
  await core.stop();
}
console.log(
  `\n${failures ? `${failures} failure(s)` : 'every archive with a mark word round trips'}, ${secs()}`,
);
process.exit(failures ? 1 : 0);
