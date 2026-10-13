// plaid-ud's Grew compiler (src/grew/index.js parseAndCompile), run over the
// cases test_grew_mirror.py writes, so the agent's port (ud/grew.py) can be
// compared with it: the same query for every pattern, or the same refusal.
//
// Reads {layers: {name: layerInfo}, cases: [[pattern, layersName]]} from the
// JSON file argv[2] and writes, for each case, {ok: {...}} or {error: {...}}.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../plaid-ud/src");
const { parseAndCompile } = await import(pathToFileURL(resolve(SRC, "grew/index.js")).href);

const { layers, cases } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = cases.map(([pattern, name]) => {
  try {
    const { query, warnings, impossible, nodes, edges } = parseAndCompile(pattern, layers[name]);
    return { ok: { query, warnings, impossible, nodes, edges } };
  } catch (e) {
    return {
      error: {
        name: e.name,
        message: e.message,
        feature: e.feature ?? null,
        line: e.line ?? null,
        col: e.col ?? null,
        sourceLine: e.sourceLine ?? null,
      },
    };
  }
});
process.stdout.write(JSON.stringify(out));
