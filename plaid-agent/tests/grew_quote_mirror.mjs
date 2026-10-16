// plaid-ud's Grew string escaper (src/grew/literals.js quote), run over the
// values test_ud_quoting.py writes, so the agent's grew_string can be held to
// it exactly: one Grew escaper, whichever app writes the pattern.
//
// Reads a JSON list of strings from the file argv[2] and writes the quoted
// literal of each.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../plaid-ud/src");
const { quote } = await import(pathToFileURL(resolve(SRC, "grew/literals.js")).href);

const values = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(JSON.stringify(values.map((v) => quote(v))));
