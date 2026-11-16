// plaid-igt's own top line of a job's report (components/projects/jobs/
// jobText.js `noticeText`), which the job page draws when the report has no
// worker's `notice` (core's own report, of a job no worker finished), run
// over the cases test_notice_mirror.py writes, so plaid_agent.core.job.notice
// and the page's line can be compared case by case (REV-RPF-W-3).
//
// Reads a JSON array of totals, the worker's snake_case keys, as argv[2], and
// writes one line (or null) per case to stdout, each read as the page reads
// it: camelCase, as the clients re-case the report. jobText.js imports the
// app's `@ui` alias, mapped to plaid-ui's source as vite maps it, so this
// needs no node_modules.
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

const { noticeText } = await import(
  pathToFileURL(
    resolve(ROOT, "plaid-igt/src/components/projects/jobs/jobText.js"),
  ).href
);
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(
  JSON.stringify(
    cases.map((t) =>
      noticeText(Object.fromEntries(Object.entries(t).map(([k, v]) => [camel(k), v]))),
    ),
  ),
);
