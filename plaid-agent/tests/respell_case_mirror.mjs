// plaid-igt's Respell screen replacer (src/domain/replacer.js), run over the
// cases test_respell_keeps_case.py writes, so the assistant's respell_all
// (core/replace.py with keep_case) can be compared with it: an any-case
// respelling writes the replacement in each match's capitals in both.
//
// Reads a JSON array of [find, replacement, values] as argv[2] and writes,
// for each, the list of rewritten values (null where a value is unchanged).
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// plaid-igt's code imports through the app's `@ui` alias, mapped here to
// plaid-ui's source as vite maps it.
const HERE = dirname(fileURLToPath(import.meta.url));
const UI = resolve(HERE, '../../plaid-ui/src');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@ui/')) {
      return next(pathToFileURL(resolve(UI, specifier.slice(4))).href, context);
    }
    return next(specifier, context);
  },
});

const { buildReplacer } = await import(
  pathToFileURL(resolve(HERE, '../../plaid-igt/src/domain/replacer.js')).href
);

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.stdout.write(
  JSON.stringify(
    cases.map(([find, replacement, values]) => {
      // The Respell screen's default match, "contains": literal, any case.
      const { apply } = buildReplacer(find, 'contains', replacement);
      return values.map((v) => apply(v));
    }),
  ),
);
