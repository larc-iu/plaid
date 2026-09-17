// The vocabulary TSV, round-tripped through Bulk Add.
//
//   node --import ./e2e/live/aliases.mjs e2e/fidelity/vocabTsv.mjs [--keep] [--out <dir>]
//
// A project zip writes one .tsv per vocabulary (runExport.js), and Bulk Add
// reads such a file back (src/import/vocabBulk.js): it "ignores the Uses
// column so our own export round-trips", and this is where that is checked.
// The file is bulk-added into an EMPTY vocabulary that already declares the
// same fields, because Bulk Add maps columns onto fields that exist and never
// makes one, and the answer to every row that could join an entry an earlier
// row made is "add", so the rows stay one entry each.
//
// Only a vocabulary's entries are in the file, so each side is compared as a
// project holding one vocabulary and nothing else, against the vocabTsv loss
// list (src/test/fidelity/formats/vocabTsv.js).
//
// The core is the campaign's private one (core.mjs), never the dev core.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { attribute, diffSnapshots } from '../../src/test/fidelity/compare.js';
import { expectRoundTrip } from '../../src/test/fidelity/expect/index.js';
import list from '../../src/test/fidelity/formats/vocabTsv.js';
import {
  AMBIGUOUS_NEW,
  CONFLICT_NEW,
  ENRICH_FILL,
  guessColumns,
  parseTable,
  planVocabImport,
  rowsToEntries,
} from '../../src/import/vocabBulk.js';
import { IGT_NAMESPACE, readVocabFields } from '../../src/domain/igtConfig.js';
import {
  exportedVocabFields,
  humanizeFieldName,
  FIELD_TYPES,
} from '../../src/domain/vocabFields.js';
import { coreForRun } from './core.mjs';
import { exportProject } from './drivers.mjs';
import { buildKitchenSink } from './kitchenSink.mjs';
import { snapshotProject } from './snapshot.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const keep = process.argv.includes('--keep');
const outDir = arg('--out');

const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

// The answers the loss list's header describes: "add" wherever a row disagrees
// with the entry an earlier row made or could belong to several, and a row that
// only fills an earlier entry's blanks fills them, which is the one case Bulk
// Add offers no other answer for.
const STRATEGIES = {
  enrich: ENRICH_FILL,
  conflict: CONFLICT_NEW,
  ambiguous: AMBIGUOUS_NEW,
};

/** A snapshot holding one vocabulary and nothing else. */
const justTheVocabulary = (snapshot, key) => ({
  name: snapshot.name,
  config: {},
  layers: [],
  documents: [],
  comments: [],
  guidelines: [],
  vocabularies: (snapshot.vocabularies || [])
    .filter((v) => v.key === key)
    .map((v) => ({ ...v, key: 'vocabulary#1', name: 'vocabulary', comments: [] })),
});

/** Bulk Add over one file, into a vocabulary that already declares the fields. */
async function bulkAdd(client, vocabId, text) {
  const vocab = await client.vocabLayers.get(vocabId, true);
  // The same fields the dialog offers columns for: the export's own field
  // order, minus the Entry fields, which hold references rather than text and
  // which Bulk Add leaves alone (BulkAddDialog.jsx).
  const fieldNames = exportedVocabFields(readVocabFields(vocab.config))
    .filter((f) => f.type !== FIELD_TYPES.ITEM)
    .map((f) => f.name);
  const { rows } = parseTable(text);
  const guess = guessColumns(rows, fieldNames, humanizeFieldName);
  const entries = rowsToEntries(rows, guess.mapping, { hasHeader: guess.hasHeader });
  const plan = planVocabImport({
    entries,
    existingItems: vocab.items || [],
    fieldNames,
    caseInsensitive: false,
    strategies: STRATEGIES,
    overrides: {},
  });
  // The same writes the dialog makes (BulkAddDialog.runImport), in its chunks.
  const CHUNK = 500;
  for (let i = 0; i < plan.creates.length; i += CHUNK) {
    await client.vocabItems.bulkCreate(
      plan.creates.slice(i, i + CHUNK).map((c) => ({
        vocabLayerId: vocabId,
        form: c.form,
        ...(Object.keys(c.metadata).length ? { metadata: c.metadata } : {}),
      })),
    );
  }
  for (let i = 0; i < plan.updates.length; i += CHUNK) {
    const chunk = plan.updates.slice(i, i + CHUNK);
    await client.batched(async (b) => {
      for (const u of chunk) b.vocabItems.patchMetadata(u.id, u.patch);
    });
  }
  return { guess, plan, rows: rows.length };
}

const core = await coreForRun({ keep });
let failures = 0;
try {
  const client = core.client;
  console.log(`core at ${core.url} (${secs()})`);
  const built = await buildKitchenSink(client, { suffix: ` ${Date.now() % 1e6}` });
  const main = built.projects.find((p) => p.role === 'main');
  console.log(`kitchen sink built (${secs()})`);

  // A project zip with the vocabulary TSVs in it: the plain-text export writes
  // them alongside whatever else it writes.
  const exported = await exportProject(client, main.id, 'plaintext', {
    includeVocabularies: true,
  });
  const files = Object.entries(unzipSync(exported.bytes)).filter(([path]) =>
    /^vocabularies\/.*\.tsv$/i.test(path),
  );
  if (!files.length) throw new Error('the project zip holds no vocabulary TSV');
  const source = await snapshotProject(client, main.id);

  for (const [path, bytes] of files) {
    const text = new TextDecoder().decode(bytes);
    const name = path.replace(/^vocabularies\//, '').replace(/\.tsv$/i, '');
    const from = (source.vocabularies || []).find((v) => v.key.startsWith(`${name}#`));
    if (!from) {
      failures += 1;
      console.log(`  FAIL ${name}: no vocabulary of that name in the project`);
      continue;
    }
    if (outDir) {
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, `${name}.tsv`), text);
    }

    // The target: a vocabulary of its own, declaring the same fields and
    // nothing else, linked to a project so the snapshot can read it.
    const target = await client.vocabLayers.create(`${name} again ${Date.now() % 1e6}`);
    const targetId = target.id ?? target;
    const fields =
      source.vocabularies.find((v) => v.key === from.key)?.config?.[IGT_NAMESPACE]?.fields || {};
    if (Object.keys(fields).length) {
      await client.vocabLayers.setConfig(targetId, IGT_NAMESPACE, 'fields', fields);
    }
    const holder = await client.projects.create(`TSV target ${Date.now() % 1e6}`);
    const holderId = holder.id ?? holder;
    await client.projects.linkVocab(holderId, targetId);

    const { plan, rows } = await bulkAdd(client, targetId, text);
    const into = await snapshotProject(client, holderId);
    const actual = justTheVocabulary(into, (into.vocabularies || [])[0]?.key);
    const { expected, actual: got } = expectRoundTrip({
      list,
      source: justTheVocabulary(source, from.key),
      actual,
    });
    const diffs = diffSnapshots(expected, got);
    if (!diffs.length) {
      console.log(`  ok   ${name}: ${rows} row(s), ${plan.creates.length} entr(ies) added`);
      continue;
    }
    failures += 1;
    console.log(`  FAIL ${name}: ${diffs.length} difference(s)`);
    for (const m of attribute(expected, got)) {
      console.log(`       ${m.key}: expected ${m.expected}, got ${m.actual}`);
    }
    for (const d of diffs.slice(0, 20)) {
      console.log(
        `       ${d.path}\n           expected ${d.expected}\n           got      ${d.actual}`,
      );
    }
    if (diffs.length > 20) console.log(`       ... ${diffs.length - 20} more`);
  }
} catch (err) {
  failures += 1;
  console.error(err);
} finally {
  await core.stop();
}
console.log(
  `\n${failures ? `${failures} failure(s)` : 'every vocabulary comes back as its list says'}, ${secs()}`,
);
process.exit(failures ? 1 : 0);
