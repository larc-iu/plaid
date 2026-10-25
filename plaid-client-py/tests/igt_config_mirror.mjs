// plaid-igt's readers of its own config namespace (domain/igtConfig.js), run
// over the configs test_igt_config_mirror.py writes, so
// plaid_client.workflows.igt.config can be compared with them answer by
// answer. Reads a JSON file of configs as argv[2] and writes the answers to
// stdout.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const config = await import(
  pathToFileURL(resolve(ROOT, "plaid-igt/src/domain/igtConfig.js")).href
);
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const each = (read) => cases.map((c) => read(c) ?? null);
process.stdout.write(
  JSON.stringify({
    namespace: config.IGT_NAMESPACE,
    lexiconFieldKey: config.LEXICON_FIELD_KEY,
    tokenizeNewTextKey: config.TOKENIZE_NEW_TEXT_KEY,
    scope: each(config.readScope),
    fieldLang: each(config.readFieldLang),
    lexiconField: each(config.readLexiconField),
    tokenizeNewText: each(config.readTokenizeNewText),
    vocabFields: each(config.readVocabFields),
  }),
);
