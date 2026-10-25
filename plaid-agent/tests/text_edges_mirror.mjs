// plaid-igt's prediction of where token edges fall once a text edit is saved
// (domain/textEdits.js `edgesAfterGaps`), run over the cases
// test_text_edges_mirror.py writes, so the agent's copy in
// plaid_agent.igt.plan can be compared with it case by case.
//
// Reads a JSON array of `{tokens, gaps}` as argv[2] and writes, per case, the
// sorted edges to stdout. textEdits.js imports the client package for its
// code-point helpers, which is mapped here to plaid-client-js's own
// codepoint.js, so this needs no node_modules.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CODEPOINT = pathToFileURL(
  resolve(ROOT, "plaid-client-js/src/codepoint.js"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@larc-iu/plaid-client") return next(CODEPOINT, context);
    return next(specifier, context);
  },
});

const { edgesAfterGaps } = await import(
  pathToFileURL(resolve(ROOT, "plaid-igt/src/domain/textEdits.js")).href
);
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(
  JSON.stringify(
    cases.map(({ tokens, gaps }) =>
      [...edgesAfterGaps([{ tokens }], gaps)].sort((a, b) => a - b),
    ),
  ),
);
