// The app's Bulk Add table reader, run over the texts save_file wrote, so
// test_save_file_tables.py can check that every table reads back as it was saved.
//
// Reads a JSON list of texts from the path in argv[2], writes a JSON list of
// {delimiter, rows} (rows as lists of cells) to stdout.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// plaid-igt's code imports through the app's `@ui` alias, mapped here to
// plaid-ui's source as vite maps it.
const UI = resolve(dirname(fileURLToPath(import.meta.url)), '../../plaid-ui/src');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@ui/')) {
      return next(pathToFileURL(resolve(UI, specifier.slice(4))).href, context);
    }
    return next(specifier, context);
  },
});

const IMPORT = resolve(dirname(fileURLToPath(import.meta.url)), '../../plaid-igt/src/import');
const { parseTable } = await import(`${IMPORT}/vocabBulk.js`);

const texts = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// The chip's download leads with a byte-order mark, and Bulk Add reads that file.
const out = texts.map((t) => {
  const { delimiter, rows } = parseTable('﻿' + t);
  return { delimiter, rows: rows.map((r) => r.cells) };
});
process.stdout.write(JSON.stringify(out));
