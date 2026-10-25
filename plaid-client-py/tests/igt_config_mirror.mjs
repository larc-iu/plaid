// plaid-igt's readers of its own config namespace (domain/igtConfig.js), run
// over the configs test_igt_config_mirror.py writes, so
// plaid_client.workflows.igt.config can be compared with them answer by
// answer, and the orthography key helpers too. Reads a JSON file of configs
// as argv[2] and writes the answers to stdout.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const config = await import(
  pathToFileURL(resolve(ROOT, "plaid-igt/src/domain/igtConfig.js")).href
);
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const each = (read) => cases.map((c) => read(c) ?? null);
// The orthography key helpers, over the names and keys the Python test names.
const ORTHOGRAPHY_NAMES = ["IPA", "", "orthog:x", "Cyrillic (old)"];
const ORTHOGRAPHY_KEYS = ["orthog:IPA", "orthog:", "Orthog:IPA", "IPA", "", null, 3];
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
    orthographyKey: ORTHOGRAPHY_NAMES.map(config.orthographyKey),
    isOrthographyKey: ORTHOGRAPHY_KEYS.map(config.isOrthographyKey),
    orthographyName: ORTHOGRAPHY_NAMES.map((n) =>
      config.orthographyName(config.orthographyKey(n)),
    ),
  }),
);
