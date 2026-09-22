// index.d.ts is a hand-kept parallel of index.js: every bundle method, every
// method on the client, every named export and every TASKS key has to be
// written twice. It had drifted — TASKS.DRAFT_GRAPH, messages.attachServiceRequest,
// messages.cancelServiceRequest, projects.myLastEdits and the documentVersions
// property were all missing — so this test reads the declarations back and
// names whatever the file has stopped covering.
//
// It reads the live client by reflection, not the source text, so a method
// added in any shape is seen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as api from "../src/index.js";
import { PlaidClient } from "../src/index.js";
import { TASKS } from "../src/serviceSchema.js";

const here = dirname(fileURLToPath(import.meta.url));
const declarations = readFileSync(join(here, "..", "index.d.ts"), "utf8");

/** The body of `<keyword> <name> {` ... `\n}` in the declaration file. */
function blockBody(header) {
  const start = declarations.indexOf(header);
  assert.notEqual(start, -1, `index.d.ts has no \`${header}\``);
  const from = start + header.length;
  const end = declarations.indexOf("\n}", from);
  assert.notEqual(end, -1, `\`${header}\` is never closed in index.d.ts`);
  return declarations.slice(from, end);
}

/** The names declared as methods (`name(` / `name<T>(`) in a block body. */
function declaredMethods(body) {
  return new Set([...body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*[<(]/gm)].map((m) => m[1]));
}

const classBody = blockBody("export declare class PlaidClient {");
const client = new PlaidClient("http://localhost:1", "token");

test("every bundle method is declared in index.d.ts", () => {
  const bundles = Object.entries(client).filter(
    ([, value]) =>
      value &&
      typeof value === "object" &&
      Object.values(value).some((v) => typeof v === "function"),
  );
  assert.ok(bundles.length > 20, "the client should expose its resource bundles");

  for (const [name, bundle] of bundles) {
    const declared = classBody.match(new RegExp(`^\\s{2}${name}:\\s*(\\w+);`, "m"));
    assert.ok(declared, `PlaidClient.${name} is not declared in index.d.ts`);
    const methods = declaredMethods(blockBody(`interface ${declared[1]} {`));
    const missing = Object.entries(bundle)
      .filter(([key, value]) => typeof value === "function" && !methods.has(key))
      .map(([key]) => `${name}.${key}`);
    assert.deepEqual(missing, [], `missing from index.d.ts: ${missing.join(", ")}`);
  }
});

test("every method and public field on the client is declared in index.d.ts", () => {
  const onClass = declaredMethods(classBody);
  const fields = new Set(
    [...classBody.matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)[?]?:/gm)].map((m) => m[1]),
  );
  const own = Object.entries(client)
    .filter(([key]) => !key.startsWith("_"))
    .map(([key, value]) => [key, typeof value === "function" ? onClass : fields]);
  const inherited = Object.getOwnPropertyNames(PlaidClient.prototype)
    .filter((key) => key !== "constructor" && !key.startsWith("_"))
    .map((key) => [key, onClass]);

  const missing = [...own, ...inherited]
    .filter(([key, declared]) => !declared.has(key))
    .map(([key]) => key);
  assert.deepEqual(missing, [], `missing from index.d.ts: ${missing.join(", ")}`);
});

test("every TASKS key is declared in index.d.ts", () => {
  const body = blockBody("export const TASKS: {");
  const declared = new Set([...body.matchAll(/readonly\s+([A-Z_]+):/g)].map((m) => m[1]));
  const missing = Object.keys(TASKS).filter((key) => !declared.has(key));
  assert.deepEqual(missing, [], `missing from index.d.ts: ${missing.join(", ")}`);
  const values = new Set([...body.matchAll(/readonly\s+[A-Z_]+:\s*"([^"]+)"/g)].map((m) => m[1]));
  const wrong = Object.entries(TASKS).filter(([, value]) => !values.has(value));
  assert.deepEqual(wrong.map(([k]) => k), [], "a task's wire value differs from its declaration");
});

test("every named export is declared in index.d.ts", () => {
  const declared = new Set(
    [
      ...declarations.matchAll(
        /^export\s+(?:declare\s+)?(?:const|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
      ),
    ].map((m) => m[1]),
  );
  const missing = Object.keys(api).filter((name) => name !== "default" && !declared.has(name));
  assert.deepEqual(missing, [], `missing from index.d.ts: ${missing.join(", ")}`);
});
