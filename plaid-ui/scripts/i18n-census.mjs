// What is left to translate under a directory or in a file:
//
//   node plaid-ui/scripts/i18n-census.mjs plaid-igt/src/components/export
//   node plaid-ui/scripts/i18n-census.mjs --summary plaid-igt/src
//   node plaid-ui/scripts/i18n-census.mjs --keys plaid-igt/src/components/export
//
// The first lists every unwrapped string with its kind (see
// src/test/i18nCensus.js). --summary counts them per directory. --keys prints
// the messages the code passes to t(), tx() and msg(), as JSON, for a catalog.
import path from 'node:path';
import { scanPath } from '../src/test/i18nCensus.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const targets = args.filter((a) => !a.startsWith('--'));
if (!targets.length) {
  console.error('usage: i18n-census.mjs [--summary|--keys] <dir or file>...');
  process.exit(2);
}
const scanned = targets.flatMap((t) => scanPath(t));

if (flags.has('--keys')) {
  const keys = [...new Set(scanned.flatMap((f) => f.keys.map((k) => k.key)))].sort();
  console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, ''])), null, 2));
} else if (flags.has('--summary')) {
  const byDir = new Map();
  for (const f of scanned) {
    const dir = path.dirname(f.file);
    const row = byDir.get(dir) ?? { hard: 0, sentence: 0, keys: 0 };
    row.hard += f.unwrapped.filter((u) => u.kind !== 'sentence').length;
    row.sentence += f.unwrapped.filter((u) => u.kind === 'sentence').length;
    row.keys += f.keys.length;
    byDir.set(dir, row);
  }
  let total = { hard: 0, sentence: 0, keys: 0 };
  for (const [dir, row] of [...byDir].sort()) {
    if (row.hard || row.sentence || row.keys) {
      console.log(
        `${String(row.hard).padStart(5)} ${String(row.sentence).padStart(5)} ${String(row.keys).padStart(5)}  ${dir}`,
      );
    }
    total = {
      hard: total.hard + row.hard,
      sentence: total.sentence + row.sentence,
      keys: total.keys + row.keys,
    };
  }
  console.log(
    `${String(total.hard).padStart(5)} ${String(total.sentence).padStart(5)} ${String(total.keys).padStart(5)}  TOTAL (unwrapped, sentences to judge, messages)`,
  );
} else {
  for (const f of scanned) {
    for (const u of f.unwrapped)
      console.log(`${f.file}:${u.line}  [${u.kind}]  ${u.text.slice(0, 110)}`);
  }
}
