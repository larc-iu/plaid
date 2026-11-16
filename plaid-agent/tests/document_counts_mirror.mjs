// plaid-igt's count of a job report's documents (components/projects/jobs/
// jobText.js `documentCounts`), run over the reports
// test_document_counts_mirror.py writes, so plaid_agent.igt.job's
// `document_counts` and the page can be compared case by case (REV-RPF3-4).
// Each report is read as the page reads it, every key camelCase, as the
// clients re-case the report.
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

const { documentCounts } = await import(
  pathToFileURL(
    resolve(ROOT, "plaid-igt/src/components/projects/jobs/jobText.js"),
  ).href
);
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const deep = (v) =>
  Array.isArray(v)
    ? v.map(deep)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [camel(k), deep(x)]),
        )
      : v;
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(JSON.stringify(cases.map((r) => documentCounts(deep(r)))));
