// plaid-ui's order of document and project names (domain/collation.js
// `compareNames`), run over the names test_name_order.py writes, so
// plaid_agent.core.tools.name_key and the apps' lists can be compared.
//
// Reads a JSON array of names as argv[2] and writes them, sorted, as one JSON
// array to stdout. collation.js imports nothing, so this needs no
// node_modules.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { compareNames } = await import(
  pathToFileURL(resolve(ROOT, "plaid-ui/src/domain/collation.js")).href
);

const names = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(JSON.stringify([...names].sort(compareNames)));
