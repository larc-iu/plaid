// plaid-igt's ignored-token rule and its word splitter, run over the cases
// test_igt_tokens_mirror.py writes, so the Python copies can be compared with
// them answer by answer: `is_token_ignored` (plaid_client.workflows.igt.ignored)
// against igtConfig.js's `isTokenIgnored`, and `split_words`
// (plaid_client.workflows.igt.new_words) against tokenizationUtils.js's
// `tokenizeText`.
//
// And "Tokenize new text" (newTextWords.js) against
// `new_text_words` (plaid_client.workflows.igt.new_words), which the igt
// assistant and the ASR transcription read.
//
// The rules read generated tables of character classes
// (plaid-igt/tools/punctuationClasses.mjs, tools/spacelessScripts.mjs), so the
// answers do not depend on the Unicode version of the node running this. The
// tables go out too, to be compared with the Python copies written from the
// same runs.
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
const spaceless = await import(
  pathToFileURL(resolve(SRC, "domain/spacelessScripts.js")).href
);
const newWords = await import(
  pathToFileURL(resolve(SRC, "domain/newTextWords.js")).href
);

// The code points a predicate holds for, as ranges: the spaceless table (not
// exported itself) and the editor's word-break punctuation class.
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
const spacelessRanges = () => rangesOf(spaceless.isSpacelessScript);

const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const len = (text) => Array.from(text).length;
process.stdout.write(
  JSON.stringify({
    tables: {
      punctOrSymbol: classes.PUNCT_OR_SYMBOL,
      pictographic: classes.PICTOGRAPHIC,
      spaceless: spacelessRanges(),
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
    newWords: (cases.newWords || []).map((c) =>
      newWords.newTextWords(c).map((w) => [w.begin, w.end]),
    ),
  }),
);
