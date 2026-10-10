// The generated index.d.ts, type-checked from a strict TypeScript consumer
// (typecheck/consumer.ts). The declarations are made the way `npm run types`
// makes them, into a scratch directory, so the check sees what the package
// and the server's /client/ ship.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const run = (args) => {
  try {
    execFileSync(process.execPath, [tsc, ...args], {
      cwd: root,
      encoding: "utf8",
    });
    return "";
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}` || e.message;
  }
};

test("a strict TypeScript consumer type-checks against the generated declarations", () => {
  const dir = mkdtempSync(join(tmpdir(), "plaid-client-types-"));
  try {
    assert.equal(
      run(["-p", "tsconfig.json", "--outDir", join(dir, "dts")]),
      "",
    );
    cpSync(join(root, "typecheck", "consumer.ts"), join(dir, "consumer.ts"));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "es2022",
          module: "nodenext",
          moduleResolution: "nodenext",
          lib: ["es2022", "dom"],
          skipLibCheck: false,
          types: [],
        },
        files: ["consumer.ts"],
      }),
    );
    assert.equal(run(["-p", join(dir, "tsconfig.json")]), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
