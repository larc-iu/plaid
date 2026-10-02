// plaid-igt's ignored-token rule and its word splitter, run over the cases
// test_igt_tokens_mirror.py writes, so the Python copies can be compared with
// them answer by answer: `is_token_ignored` (plaid_client.workflows.igt.ignored)
// against igtConfig.js's `isTokenIgnored`, and the agent's `split_words`
// (plaid_agent/igt/project.py) against tokenizationUtils.js's `tokenizeText`.
//
// Both rules read one generated table of character classes
// (plaid-igt/tools/punctuationClasses.mjs), so the answers do not depend on
// the Unicode version of the node running this. The table goes out too, to be
// compared with the Python copy written from the same run.
//
// Reads a JSON file of cases as argv[2] and writes the answers to stdout.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../plaid-igt/src");
const config = await import(pathToFileURL(resolve(SRC, "domain/igtConfig.js")).href);
const tokenization = await import(
  pathToFileURL(resolve(SRC, "utils/tokenizationUtils.js")).href
);
const classes = await import(
  pathToFileURL(resolve(SRC, "domain/punctuationClasses.js")).href
);

const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const len = (text) => Array.from(text).length;
process.stdout.write(
  JSON.stringify({
    tables: {
      punctOrSymbol: classes.PUNCT_OR_SYMBOL,
      pictographic: classes.PICTOGRAPHIC,
    },
    ignored: cases.configs.map((cfg) =>
      cases.tokens.map((t) => config.isTokenIgnored(t, cfg)),
    ),
    words: cases.configs.map((cfg) =>
      cases.texts.map((text) =>
        tokenization
          .tokenizeText(text, cfg, [{ start: 0, end: len(text) }])
          .map((t) => [t.begin, t.end]),
      ),
    ),
  }),
);
