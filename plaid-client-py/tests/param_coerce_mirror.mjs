// plaid-client-js's coerceParamValues, run over the cases
// test_param_coerce_mirror.py writes, so plaid_client.service_schema.coerce
// can be compared with it answer by answer.
//
// Reads a JSON file of cases as argv[2] and writes the answers to stdout. A
// number that JSON cannot carry is written as its string.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { coerceParamValues } = await import(
  pathToFileURL(resolve(ROOT, "plaid-client-js/src/serviceSchema.js")).href
);
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const answers = cases.map(({ schema, raw }) => {
  const v = coerceParamValues(schema, raw).values.n;
  return typeof v === "number" && !Number.isFinite(v) ? String(v) : v;
});
process.stdout.write(JSON.stringify(answers));
