// plaid-igt's ignored-token rule and its word splitter, run over the cases
// test_igt_tokens_mirror.py writes, so the Python copies can be compared with
// them answer by answer: `is_token_ignored` (plaid_client.workflows.igt.ignored)
// against igtConfig.js's `isTokenIgnored`, and `split_words`
// (plaid_client.workflows.igt.word_breaks) against tokenizationUtils.js's
// `tokenizeText`.
//
// The rules read generated tables of character classes
// (plaid-igt/tools/punctuationClasses.mjs), so the
// answers do not depend on the Unicode version of the node running this. The
// tables go out too, to be compared with the Python copies written from the
// same runs.
//
// Reads a JSON file of cases as argv[2] and writes the answers to stdout.
// tokenizationUtils.js imports through the app's `@ui` alias, which is mapped
// here to plaid-ui's source as vite maps it.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const UI = resolve(ROOT, "plaid-ui/src");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@ui/")) {
      return next(pathToFileURL(resolve(UI, specifier.slice(4))).href, context);
    }
    return next(specifier, context);
  },
});

const SRC = resolve(ROOT, "plaid-igt/src");
const config = await import(pathToFileURL(resolve(SRC, "domain/igtConfig.js")).href);
const tokenization = await import(
  pathToFileURL(resolve(SRC, "utils/tokenizationUtils.js")).href
);
const classes = await import(
  pathToFileURL(resolve(UI, "domain/punctuationClasses.js")).href
);

// The code points a predicate holds for, as ranges: the editor's word-break
// punctuation class.
const rangesOf = (holds) => {
  const out = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (!holds(String.fromCodePoint(cp))) continue;
    const last = out[out.length - 1];
    if (last && last[1] === cp - 1) last[1] = cp;
    else out.push([cp, cp]);
  }
  return out;
};

const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const len = (text) => Array.from(text).length;
process.stdout.write(
  JSON.stringify({
    tables: {
      punctOrSymbol: classes.PUNCT_OR_SYMBOL,
      pictographic: classes.PICTOGRAPHIC,
      breaks: rangesOf(tokenization.isUnicodePunctuation),
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
