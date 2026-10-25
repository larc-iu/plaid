// plaid-igt's own rules for a field (domain/igtConstraints.js
// `fieldConstraints`), run over the cases test_field_constraints_mirror.py
// writes, so plaid_client.workflows.igt.tagsets.field_constraints, which the
// assistant reads to say core will refuse an approval, can be compared with
// them case by case.
//
// Reads a JSON array of `[spanLayerConfig, projectConfig]` as argv[2] and
// writes one list of rules per case to stdout. igtConstraints.js imports the
// client package, mapped here to plaid-client-js's own source, and through
// tagsets.js the app's `@ui` alias, mapped to plaid-ui's source as vite maps
// it, so this needs no node_modules.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const UI = resolve(ROOT, "plaid-ui/src");
const CLIENT = pathToFileURL(
  resolve(ROOT, "plaid-client-js/src/index.js"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@larc-iu/plaid-client") return next(CLIENT, context);
    if (specifier.startsWith("@ui/")) {
      return next(pathToFileURL(resolve(UI, specifier.slice(4))).href, context);
    }
    return next(specifier, context);
  },
});

const { fieldConstraints } = await import(
  pathToFileURL(resolve(ROOT, "plaid-igt/src/domain/igtConstraints.js")).href
);
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(
  JSON.stringify(
    cases.map(([layer, project]) => fieldConstraints(layer, project)),
  ),
);
