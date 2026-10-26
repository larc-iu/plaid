// The JS client's entry-form rule, run over the cases
// test_entry_forms_mirror.py writes, so plaid_client.workflows.igt.entry_forms
// can be compared with it answer by answer. Reads a JSON file of [type, form]
// pairs as argv[2] and writes the answers to stdout.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const forms = await import(
  pathToFileURL(resolve(ROOT, "plaid-client-js/src/entryForms.js")).href
);
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(
  JSON.stringify({
    types: forms.MORPH_TYPES,
    entry: cases.map(([t, f]) => forms.entryForm(t, f)),
    decorated: cases.map(([t, f]) => forms.decorateWithAffixMarkers(t, f) ?? null),
    decoratedAfterEquals: cases.map(
      ([t, f]) => forms.decorateWithAffixMarkers(t, f, { equalsBefore: true }) ?? null,
    ),
  }),
);
